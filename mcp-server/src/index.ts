import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, "../..");
const gameDirectory = resolve(projectRoot, "run");
const baseUrl = process.env.MINECRAFT_MCP_URL ?? "http://127.0.0.1:8765";
const tokenFile = process.env.MINECRAFT_MCP_TOKEN_FILE
  ?? resolve(gameDirectory, "config/minecraft-mcp/bridge-token.txt");
const MAX_PROCESS_OUTPUT_CHARS = 128 * 1024;
const MAX_LOG_BYTES = 192 * 1024;
const MAX_CRASH_BYTES = 48 * 1024;
const MAX_LOG_RETURN_CHARS = 24 * 1024;

const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedBaseUrl.hostname)) {
  throw new Error("MINECRAFT_MCP_URL must use plain HTTP on the local loopback interface");
}

const server = new McpServer({
  name: "minecraft-debug",
  version: "0.2.0",
}, {
  instructions: "Use launch_game to start this repository's isolated Fabric development client with Minecraft-MCP already loaded. Poll get_game_process_status until bridgeReady is true. Use get_menu_state and the bounded menu tools for UI flows. Use get_game_status before in-world actions and wait for worldReady=true before movement. Existing local saves can only be opened as allowlisted disposable snapshots. Never construct shell commands or arbitrary paths.",
});

type ManagedRun = {
  id: string;
  child: ChildProcess;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  spawnError?: string;
  output: string;
  stopRequested: boolean;
};

let managedRun: ManagedRun | null = null;
let launchInProgress = false;
let shutdownInProgress = false;

function appendProcessOutput(run: ManagedRun, chunk: Buffer | string): void {
  run.output += chunk.toString();
  if (run.output.length > MAX_PROCESS_OUTPUT_CHARS) {
    run.output = run.output.slice(-MAX_PROCESS_OUTPUT_CHARS);
  }
}

function childIsRunning(run: ManagedRun | null): boolean {
  return run !== null && run.exitCode === null && run.exitSignal === null && !run.spawnError;
}

function redactText(input: string): string {
  let output = input;
  for (const localPath of [projectRoot, gameDirectory, process.env.HOME, process.env.USERPROFILE]) {
    if (localPath) output = output.replaceAll(localPath, "<local-path>");
  }
  output = output
    .replace(/(?:[A-Za-z]:\\Users\\|\\\\[^\\\s]+\\)[^\r\n\s"']+/g, "<local-path>")
    .replace(/\/(?:home|Users)\/[^/\r\n\s"']+(?:\/[^\r\n\s"']*)?/g, "<local-path>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<redacted-token>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<redacted-id>")
    .replace(/(--username=)[^\s]+/gi, "$1<redacted>")
    .replace(/((?:player\s*name|username|user\s*name|profile\s*name)\s*[:=]\s*)[^\r\n]+/gi, "$1<redacted>");
  return output;
}

function buildResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function asToolError(error: unknown) {
  const message = redactText(error instanceof Error ? error.message : String(error));
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function readToken(): Promise<string> {
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!token) throw new Error("empty token");
    return token;
  } catch {
    throw new Error("Minecraft bridge token is unavailable. Start the development client with launch_game or set MINECRAFT_MCP_TOKEN_FILE for another local profile.");
  }
}

async function callBridge(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await readToken();
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(path.includes("/worlds/") ? 180_000 : 10_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : `Minecraft bridge returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function callBridgeImage(path: string): Promise<string> {
  const token = await readToken();
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "image/png" },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const message = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : `Minecraft bridge returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!response.headers.get("content-type")?.startsWith("image/png")) {
    throw new Error("Minecraft bridge did not return a PNG image");
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 6 * 1024 * 1024) throw new Error("Screenshot exceeds the 6 MiB response limit");
  return data.toString("base64");
}

async function isBridgeReachable(timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "service" in body && body.service === "minecraft-mcp";
  } catch {
    return false;
  }
}

function gradleCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const wrapper = resolve(projectRoot, "gradlew.bat");
    return { command: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", `"${wrapper}" --console=plain runClient`] };
  }
  return { command: resolve(projectRoot, "gradlew"), args: ["--console=plain", "runClient"] };
}

function sendManagedSignal(run: ManagedRun, signal: NodeJS.Signals): void {
  if (run.child.pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGINT") {
      run.child.kill(signal);
      return;
    }
    spawnSync("taskkill", ["/pid", String(run.child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-run.child.pid, signal);
  } catch {
    run.child.kill(signal);
  }
}

async function waitForRunToStop(run: ManagedRun, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!childIsRunning(run) && !(await isBridgeReachable(400))) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  }
  return !childIsRunning(run) && !(await isBridgeReachable(400));
}

async function stopManagedRun(): Promise<Record<string, unknown>> {
  const run = managedRun;
  if (!run) return { stopped: false, state: "not-started", message: "No managed development client has been launched in this MCP session." };
  if (!childIsRunning(run) && !(await isBridgeReachable())) {
    return { stopped: false, runId: run.id, state: run.spawnError ? "failed" : "stopped", exitCode: run.exitCode, exitSignal: run.exitSignal };
  }

  run.stopRequested = true;
  sendManagedSignal(run, "SIGINT");
  if (await waitForRunToStop(run, 15_000)) {
    return { stopped: true, runId: run.id, state: "stopped", exitCode: run.exitCode, exitSignal: run.exitSignal };
  }
  sendManagedSignal(run, "SIGTERM");
  if (await waitForRunToStop(run, 5_000)) {
    return { stopped: true, runId: run.id, state: "stopped", exitCode: run.exitCode, exitSignal: run.exitSignal, forced: true };
  }
  sendManagedSignal(run, "SIGKILL");
  const stopped = await waitForRunToStop(run, 3_000);
  return { stopped, runId: run.id, state: stopped ? "stopped" : "stopping", exitCode: run.exitCode, exitSignal: run.exitSignal, forced: true };
}

function processState(run: ManagedRun | null, bridgeReady: boolean): string {
  if (!run) return bridgeReady ? "running-unmanaged" : "not-started";
  if (run.spawnError) return "failed-to-start";
  if (bridgeReady) return childIsRunning(run) ? "ready" : "bridge-ready";
  if (childIsRunning(run)) {
    return Date.now() - Date.parse(run.startedAt) > 10 * 60 * 1000 ? "startup-timeout" : "starting";
  }
  if (run.stopRequested && !bridgeReady) return "stopped";
  if (run.exitCode === 0 && !bridgeReady) return "stopped";
  return "crashed";
}

async function readTail(path: string, maxBytes: number): Promise<string | null> {
  try {
    const file = await open(path, "r");
    try {
      const details = await file.stat();
      const length = Math.min(details.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, details.size - length);
      return buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function latestCrashReport(): Promise<{ name: string; modifiedAt: string; text: string } | null> {
  const directory = resolve(gameDirectory, "crash-reports");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^crash-.*\.txt$/i.test(entry.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        const details = await stat(path);
        return { path, name: entry.name, modifiedAt: details.mtime };
      }));
    candidates.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    const latest = candidates[0];
    if (!latest) return null;
    const text = await readTail(latest.path, MAX_CRASH_BYTES);
    if (text === null) return null;
    return { name: latest.name, modifiedAt: latest.modifiedAt.toISOString(), text: redactText(text) };
  } catch {
    return null;
  }
}

server.registerTool("launch_game", {
  description: "Build and launch this repository's isolated Minecraft 26.3 Fabric development client with Minecraft-MCP already loaded. This starts only the fixed Gradle runClient task in the project root; poll get_game_process_status for bridge readiness.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async () => {
  if (launchInProgress) return buildResult({ started: false, state: "starting", message: "A launch request is already being handled." });
  if (managedRun && childIsRunning(managedRun)) {
    return buildResult({ started: false, runId: managedRun.id, state: processState(managedRun, await isBridgeReachable()), message: "The managed development client is already running." });
  }
  const bridgeAlreadyReady = await isBridgeReachable();
  if (launchInProgress) return buildResult({ started: false, state: "starting", message: "A launch request is already being handled." });
  if (managedRun && childIsRunning(managedRun)) {
    return buildResult({ started: false, runId: managedRun.id, state: processState(managedRun, bridgeAlreadyReady), message: "The managed development client is already running." });
  }
  if (bridgeAlreadyReady) {
    return buildResult({ started: false, state: "running-unmanaged", bridgeReady: true, message: "A Minecraft-MCP development client is already reachable; refusing to start a second client." });
  }

  launchInProgress = true;
  try {
    const launch = gradleCommand();
    const child = spawn(launch.command, launch.args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const run: ManagedRun = {
      id: randomUUID(), child, startedAt: new Date().toISOString(), exitCode: null, exitSignal: null,
      output: "", stopRequested: false,
    };
    managedRun = run;
    child.stdout?.on("data", (chunk: Buffer | string) => appendProcessOutput(run, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendProcessOutput(run, chunk));
    child.on("error", (error) => {
      run.spawnError = redactText(error.message);
      run.exitCode = 1;
      run.finishedAt = new Date().toISOString();
      appendProcessOutput(run, `\nLauncher process error: ${error.message}\n`);
    });
    child.on("exit", (code, signal) => {
      run.exitCode = code;
      run.exitSignal = signal;
      run.finishedAt = new Date().toISOString();
    });
    return buildResult({ started: true, runId: run.id, state: "starting", task: "runClient", startedAt: run.startedAt,
      message: "Development client launch accepted. Poll get_game_process_status until bridgeReady is true." });
  } catch (error) {
    return asToolError(error);
  } finally {
    launchInProgress = false;
  }
});

server.registerTool("get_game_process_status", {
  description: "Report the managed Gradle/Minecraft process state, bridge readiness, exit status, and whether a recent crash report exists. Does not change the game.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const bridgeReady = await isBridgeReachable();
    const run = managedRun;
    const crash = await latestCrashReport();
    const value = {
      state: processState(run, bridgeReady),
      bridgeReady,
      processManaged: run !== null,
      runId: run?.id ?? null,
      startedAt: run?.startedAt ?? null,
      elapsedMs: run ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : null,
      finishedAt: run?.finishedAt ?? null,
      exitCode: run?.exitCode ?? null,
      exitSignal: run?.exitSignal ?? null,
      processError: run?.spawnError ?? null,
      recentCrashReportAvailable: crash !== null,
      recentCrashReportName: crash?.name ?? null,
    };
    return buildResult(value);
  } catch (error) { return asToolError(error); }
});

server.registerTool("stop_game", {
  description: "Gracefully stop the Minecraft development client launched by this MCP server. Uses bounded SIGINT/SIGTERM/SIGKILL escalation and will not stop an unmanaged client.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult(await stopManagedRun()); }
  catch (error) { return asToolError(error); }
});

server.registerTool("get_recent_logs", {
  description: "Return a bounded tail of Minecraft latest.log and Gradle launcher output, with local paths, identifiers, usernames, and token-shaped values redacted.",
  inputSchema: { maxLines: z.number().int().min(20).max(400).default(120) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ maxLines }) => {
  try {
    const [gameLog, crash] = await Promise.all([
      readTail(resolve(gameDirectory, "logs/latest.log"), MAX_LOG_BYTES),
      latestCrashReport(),
    ]);
    const launcherOutput = managedRun?.output ?? "";
    const value = {
      gameLog: gameLog === null ? null : redactText(gameLog.split(/\r?\n/).slice(-maxLines).join("\n").slice(-MAX_LOG_RETURN_CHARS)),
      launcherOutput: redactText(launcherOutput.split(/\r?\n/).slice(-maxLines).join("\n").slice(-MAX_LOG_RETURN_CHARS)),
      latestCrashReport: crash ? { name: crash.name, modifiedAt: crash.modifiedAt } : null,
      maxLines,
    };
    return buildResult(value);
  } catch (error) { return asToolError(error); }
});

server.registerTool("get_crash_report", {
  description: "Return the most recent bounded Minecraft crash report from this project's isolated development directory. Local paths and player identifiers are redacted.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const crash = await latestCrashReport();
    if (!crash) return buildResult({ available: false, message: "No Minecraft crash report was found in the development run directory." });
    return buildResult({ available: true, name: crash.name, modifiedAt: crash.modifiedAt, text: crash.text, truncated: crash.text.length >= MAX_CRASH_BYTES });
  } catch (error) { return asToolError(error); }
});

server.registerTool("get_game_status", {
  description: "Read local Minecraft state, including the current screen, whether a world is fully ready, and player position/view angles. Wait for worldReady=true before in-world actions. Does not change the game.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const status = await callBridge("/v1/status");
    return buildResult(status as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("get_game_performance", {
  description: "Read client FPS/frame time, JVM heap use, loaded mod versions, and integrated single-player server tick timing when available. Does not change the game.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult(await callBridge("/v1/performance") as Record<string, unknown>); }
  catch (error) { return asToolError(error); }
});

server.registerTool("get_menu_state", {
  description: "Inspect the current Minecraft menu screen and its visible controls. Control indexes are valid only for the returned screenRevision. Use this before clicking a menu control or editing a text field.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult(await callBridge("/v1/ui") as Record<string, unknown>); }
  catch (error) { return asToolError(error); }
});

server.registerTool("open_create_world_menu", {
  description: "Open Minecraft's real Create World interface in the development client. A world created from this screen is tracked as generated so it can be cleaned up later. Requires no active world.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async () => {
  try {
    return buildResult(await callBridge("/v1/ui/open-create-world", { method: "POST" }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("click_menu_control", {
  description: "Click a visible control on the current Minecraft screen by its index from get_menu_state. Refuses stale screen revisions, hidden/disabled controls, and destructive world-management buttons. Use load_world_snapshot for existing saves.",
  inputSchema: {
    screenRevision: z.number().int().nonnegative(),
    index: z.number().int().min(0).max(127),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ screenRevision, index }) => {
  try {
    return buildResult(await callBridge("/v1/ui/click", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenRevision, index }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("set_menu_text", {
  description: "Set a visible Minecraft text field by its index from get_menu_state. Use bounded text and inspect the screen again before submitting the form.",
  inputSchema: {
    screenRevision: z.number().int().nonnegative(),
    index: z.number().int().min(0).max(127),
    value: z.string().max(128).refine((value) => ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }), { message: "Text cannot contain control characters" }),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ screenRevision, index, value }) => {
  try {
    return buildResult(await callBridge("/v1/ui/text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenRevision, index, value }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("press_menu_key", {
  description: "Send one allowlisted navigation key to the current Minecraft menu screen. Enter is disabled on saved-world selection to prevent opening the original save; use load_world_snapshot instead.",
  inputSchema: {
    screenRevision: z.number().int().nonnegative(),
    key: z.enum(["enter", "escape", "tab", "up", "down", "left", "right", "space", "backspace"]),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ screenRevision, key }) => {
  try {
    return buildResult(await callBridge("/v1/ui/key", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenRevision, key }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("look", {
  description: "Set the local player's view direction. Yaw is degrees in [-36000, 36000]; pitch is degrees in [-90, 90]. Requires a loaded world and changes only the player's view.",
  inputSchema: {
    yaw: z.number().finite().min(-36000).max(36000).describe("Horizontal view angle in degrees"),
    pitch: z.number().finite().min(-90).max(90).describe("Vertical view angle in degrees"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ yaw, pitch }) => {
  try {
    return buildResult(await callBridge("/v1/look", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaw, pitch }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("move", {
  description: "Hold one movement key in the local Minecraft client for a short bounded time, then release it automatically. Requires an open world and no active menu. Maximum duration is 40 ticks (2 seconds).",
  inputSchema: {
    direction: z.enum(["forward", "backward", "left", "right", "jump"]),
    ticks: z.number().int().min(1).max(40).describe("Number of client ticks to hold the key (20 ticks per second)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ direction, ticks }) => {
  try {
    return buildResult(await callBridge("/v1/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction, ticks }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("interact", {
  description: "Briefly use the currently selected item or interact with the targeted block/entity in the local world. Maximum duration is 20 ticks. Use disposable worlds for any action that may change world state.",
  inputSchema: { ticks: z.number().int().min(1).max(20).default(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ticks }) => {
  try {
    return buildResult(await callBridge("/v1/interact", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticks }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("take_screenshot", {
  description: "Capture the local Minecraft client window as a PNG and return it as an image. Works at menus or in a world; does not change the game.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const data = await callBridgeImage("/v1/screenshot");
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
  } catch (error) { return asToolError(error); }
});

server.registerTool("list_worlds", {
  description: "List worlds already saved in this isolated development client's saves directory. Loading an existing world requires its exact folder ID and opens an allowlisted disposable copy.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult(await callBridge("/v1/worlds") as Record<string, unknown>); }
  catch (error) { return asToolError(error); }
});

server.registerTool("create_test_world", {
  description: "Create a new normal-terrain single-player test world with a unique mcp_test_ save ID. This is a shortcut; use the menu tools to exercise the actual Create World interface. Requires no active world; an optional integer seed makes terrain reproducible.",
  inputSchema: { seed: z.number().int().safe().optional().describe("Optional deterministic world seed") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ seed }) => {
  try {
    return buildResult(await callBridge("/v1/worlds/create-test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seed === undefined ? {} : { seed }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("leave_test_world", {
  description: "Save and leave the current local single-player world, returning to the title screen. Use a disposable test world or copied snapshot. Does not disconnect from multiplayer servers.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async () => {
  try { return buildResult(await callBridge("/v1/worlds/leave", { method: "POST" }) as Record<string, unknown>); }
  catch (error) { return asToolError(error); }
});

server.registerTool("load_world_snapshot", {
  description: "Load an existing local save from a disposable copy. The source world is not opened or modified. Its exact folder ID must appear in list_worlds and the local world allowlist.",
  inputSchema: {
    worldId: z.string().min(1).max(128).refine((id) => {
      if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes(":")) return false;
      return [...id].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      });
    }, { message: "Use one local folder ID without separators or control characters" })
      .describe("Exact folder ID returned by list_worlds and added to world-allowlist.txt"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ worldId }) => {
  try {
    return buildResult(await callBridge("/v1/worlds/load-snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("edit_world_snapshot", {
  description: "Copy an allowlisted existing local world and open the disposable copy in Minecraft's Edit World menu. The source save stays untouched. After editing, use open_generated_world with the returned snapshotWorldId to play the copy.",
  inputSchema: {
    worldId: z.string().min(1).max(128).refine((id) => {
      if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes(":")) return false;
      return [...id].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      });
    }, { message: "Use one local folder ID without separators or control characters" }),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ worldId }) => {
  try {
    return buildResult(await callBridge("/v1/worlds/edit-snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("open_generated_world", {
  description: "Open one exact test world or snapshot created by Minecraft-MCP in the local development client. Ordinary saves cannot be opened by this tool.",
  inputSchema: {
    worldId: z.string().min(1).max(128).refine((id) => {
      if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes(":")) return false;
      return [...id].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      });
    }, { message: "Use one generated folder ID without separators or control characters" }),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ worldId }) => {
  try {
    return buildResult(await callBridge("/v1/worlds/open-generated", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("cleanup_generated_world", {
  description: "Delete one exact test world or snapshot created by Minecraft-MCP. Requires the client to be at a menu and the world to be closed; ordinary saves are never eligible.",
  inputSchema: {
    worldId: z.string().min(1).max(128).refine((id) => {
      if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes(":")) return false;
      return [...id].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      });
    }, { message: "Use one generated local folder ID without separators or control characters" }),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ worldId }) => {
  try {
    return buildResult(await callBridge("/v1/worlds/cleanup-generated", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

async function main() {
  await server.connect(new StdioServerTransport());
}

process.once("exit", () => {
  const run = managedRun;
  if (!run || !childIsRunning(run)) return;
  try {
    if (process.platform === "win32" && run.child.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(run.child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else if (run.child.pid !== undefined) {
      process.kill(-run.child.pid, "SIGTERM");
    }
  } catch { /* The process may already have exited. */ }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    void stopManagedRun().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

main().catch((error: unknown) => {
  // MCP stdio reserves stdout for protocol messages.
  console.error(redactText(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
});
