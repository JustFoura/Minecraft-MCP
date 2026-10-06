import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, "../..");
const gameDirectory = resolve(projectRoot, "run");
const modLibraryDirectory = resolve(gameDirectory, "mod-library");
const configuredBridgeUrl = process.env.MINECRAFT_MCP_URL;
let baseUrl = configuredBridgeUrl ?? "http://127.0.0.1:8765";
let bridgePort = 8765;
const tokenFile = process.env.MINECRAFT_MCP_TOKEN_FILE
  ?? resolve(gameDirectory, "config/minecraft-mcp/bridge-token.txt");
const bridgePortFile = resolve(gameDirectory, "config/minecraft-mcp/bridge-port.txt");
const targetModRegistryFile = resolve(gameDirectory, "config/minecraft-mcp/target-mod-jar.json");
const modPresetsFile = resolve(gameDirectory, "config/minecraft-mcp/mod-presets.json");
const activeModPresetFile = resolve(gameDirectory, "config/minecraft-mcp/active-mod-preset.json");
const MAX_PROCESS_OUTPUT_CHARS = 128 * 1024;
const MAX_LOG_BYTES = 192 * 1024;
const MAX_CRASH_BYTES = 48 * 1024;
const MAX_LOG_FIELD_RETURN_BYTES = 6 * 1024;
const MAX_MOD_JAR_BYTES = 512 * 1024 * 1024;
const MAX_MOD_PRESET_CONFIG_BYTES = 128 * 1024;

function validateBridgeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MINECRAFT_MCP_URL must be a valid loopback URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password) {
    throw new Error("MINECRAFT_MCP_URL must use plain HTTP on the local loopback interface");
  }
  return url;
}

if (configuredBridgeUrl) {
  const url = validateBridgeUrl(configuredBridgeUrl);
  if (!url.port) throw new Error("MINECRAFT_MCP_URL must include the local bridge port");
  bridgePort = Number(url.port);
}

const server = new McpServer({
  name: "minecraft-debug",
  version: "0.2.0",
}, {
  instructions: "This MCP launches this repository's isolated Minecraft 26.3 Fabric development client; it does not launch or build an arbitrary mod project. To test another mod, first build that project into a Fabric mod JAR compatible with this client's Minecraft/Fabric versions, then call load_mod_jar with the selected JAR's absolute path and its mod ID from fabric.mod.json as expectedModId. The JAR is copied to this instance's run/mods/mcp-target.jar. If this MCP owns the client, load_mod_jar closes it only when no world is open, restarts it, and checks Fabric's loaded-mod list; loaded=true means the expected ID was found, while loaded=false means it was absent from a complete list. If expectedModId is omitted, the list is truncated, or restartRequired=true because another MCP session owns the client, loaded is null and verification has not occurred; the other session's owner must restart it. If loading fails, inspect get_game_process_status, get_recent_logs, and get_crash_report. Use unload_mod_jar to remove only this MCP instance's staged JAR. launch_game starts the isolated client; poll get_game_process_status until bridgeReady=true. Use close_game with the exact runId returned by launch_game when targeting a specific client. Use run_menu_actions to batch safe UI steps; world creation/loading waits for worldReady, and movement/use return completed state. run_command accepts Minecraft slash commands only in MCP-generated disposable single-player worlds. Existing saves can only be opened as allowlisted disposable snapshots. Never construct shell commands or arbitrary project paths.",
});

type ManagedRun = {
  id: string;
  child: ChildProcess;
  presetTag: string;
  expectedModIds: string[];
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

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const probe = createServer();
    probe.once("error", () => resolveResult(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveResult(true)));
  });
}

async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("Could not allocate a local bridge port"));
      });
    });
  });
}

const PROJECT_BRIDGE_PORT_MIN = 20_000;
const PROJECT_BRIDGE_PORT_COUNT = 20_000;

async function findFreeProjectBridgePort(): Promise<number> {
  const digest = createHash("sha256").update(projectRoot).digest();
  const startOffset = digest.readUInt32BE(0) % PROJECT_BRIDGE_PORT_COUNT;
  for (let offset = 0; offset < PROJECT_BRIDGE_PORT_COUNT; offset++) {
    const port = PROJECT_BRIDGE_PORT_MIN + (startOffset + offset) % PROJECT_BRIDGE_PORT_COUNT;
    if (await canBindLoopbackPort(port)) return port;
  }
  return findFreeLoopbackPort();
}

async function bridgeAtPortAcceptsLocalToken(port: number): Promise<boolean> {
  try {
    const token = await readToken();
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(600),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function initializeBridgeEndpoint(): Promise<void> {
  if (configuredBridgeUrl || process.env.MINECRAFT_MCP_TOKEN_FILE) return;

  let savedPort: number | null = null;
  try {
    const value = (await readFile(bridgePortFile, "utf8")).trim();
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) savedPort = port;
  } catch { /* First run: choose and persist a port for this project directory. */ }

  if (savedPort !== null && (await canBindLoopbackPort(savedPort) || await bridgeAtPortAcceptsLocalToken(savedPort))) {
    bridgePort = savedPort;
  } else {
    bridgePort = await findFreeProjectBridgePort();
  }

  baseUrl = `http://127.0.0.1:${bridgePort}`;
  await mkdir(dirname(bridgePortFile), { recursive: true });
  await writeFile(bridgePortFile, `${bridgePort}\n`, { encoding: "utf8", mode: 0o600 });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer | string) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolveHash(hash.digest("hex")));
  });
}

type TargetModJarRecord = { stagedFile: "mcp-target.jar"; sourceName: string; sha256: string; sizeBytes: number };

async function readTargetModJarRecord(): Promise<TargetModJarRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(targetModRegistryFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("stagedFile" in parsed)
      || parsed.stagedFile !== "mcp-target.jar" || !("sourceName" in parsed) || typeof parsed.sourceName !== "string"
      || !("sha256" in parsed) || typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)
      || !("sizeBytes" in parsed) || typeof parsed.sizeBytes !== "number") {
      throw new Error("The per-project test-mod registry is invalid; refusing to change staged JARs.");
    }
    return parsed as TargetModJarRecord;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function stageTargetModJar(sourcePath: string): Promise<{ sourceName: string; sha256: string; sizeBytes: number; alreadyStaged: boolean }> {
  if (!isAbsolute(sourcePath) || sourcePath.length > 4096 || [...sourcePath].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new Error("jarPath must be one absolute local file path without control characters");
  }
  if (extname(sourcePath).toLowerCase() !== ".jar") throw new Error("The selected file must have a .jar extension");

  const resolvedPath = resolve(sourcePath);
  let sourceDetails;
  try { sourceDetails = await lstat(resolvedPath); }
  catch { throw new Error("The selected JAR could not be read"); }
  if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) throw new Error("The selected JAR must be a regular file, not a symlink");
  if (sourceDetails.size < 4 || sourceDetails.size > MAX_MOD_JAR_BYTES) {
    throw new Error("The selected JAR must be between 4 bytes and 512 MiB");
  }
  const file = await open(resolvedPath, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new Error("The selected file is not a ZIP/JAR archive");
    }
  } finally {
    await file.close();
  }

  const sourceName = basename(resolvedPath).slice(0, 160);
  const sha256 = await sha256File(resolvedPath);
  const previous = await readTargetModJarRecord();
  const modsDirectory = resolve(gameDirectory, "mods");
  const stagedPath = resolve(modsDirectory, "mcp-target.jar");
  await mkdir(modsDirectory, { recursive: true });

  let targetExists = false;
  try {
    const target = await lstat(stagedPath);
    if (!target.isFile() || target.isSymbolicLink() || previous === null) {
      throw new Error("run/mods/mcp-target.jar exists but is not managed by this MCP instance");
    }
    targetExists = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (targetExists && previous?.sha256 === sha256) {
    return { sourceName, sha256, sizeBytes: sourceDetails.size, alreadyStaged: true };
  }

  const temporaryJar = resolve(modsDirectory, `.mcp-target-${randomUUID()}.tmp`);
  const temporaryRegistry = `${targetModRegistryFile}.${randomUUID()}.tmp`;
  const backupJar = targetExists ? resolve(modsDirectory, `.mcp-target-${randomUUID()}.backup`) : null;
  try {
    await copyFile(resolvedPath, temporaryJar);
    const record: TargetModJarRecord = { stagedFile: "mcp-target.jar", sourceName, sha256, sizeBytes: sourceDetails.size };
    await writeFile(temporaryRegistry, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (backupJar) await rename(stagedPath, backupJar);
    await rename(temporaryJar, stagedPath);
    await rename(temporaryRegistry, targetModRegistryFile);
    if (backupJar) await unlink(backupJar).catch(() => {});
  } catch (error) {
    await unlink(temporaryJar).catch(() => {});
    await unlink(temporaryRegistry).catch(() => {});
    if (backupJar) {
      await unlink(stagedPath).catch(() => {});
      await rename(backupJar, stagedPath).catch(() => {});
    }
    throw new Error("Could not stage the selected JAR in this MCP instance's isolated mods folder");
  }
  return { sourceName, sha256, sizeBytes: sourceDetails.size, alreadyStaged: false };
}

async function removeStagedTargetModJar(): Promise<{ removed: boolean; sourceName?: string }> {
  const record = await readTargetModJarRecord();
  if (!record) return { removed: false };
  const stagedPath = resolve(gameDirectory, "mods", record.stagedFile);
  if (dirname(stagedPath) !== resolve(gameDirectory, "mods")) throw new Error("Staged JAR path was invalid");
  try {
    const details = await lstat(stagedPath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Staged JAR is no longer a regular file; refusing to remove it");
    if (await sha256File(stagedPath) !== record.sha256) throw new Error("Staged JAR changed outside this MCP instance; refusing to remove it");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await unlink(targetModRegistryFile).catch(() => {});
      return { removed: false };
    }
    throw error;
  }
  await unlink(stagedPath);
  await unlink(targetModRegistryFile);
  return { removed: true, sourceName: record.sourceName };
}

type PresetModSelection = { file: string; modId: string };
type ActivePresetMod = { stagedFile: string; sourceFile: string; modId: string; sha256: string; sizeBytes: number };
type ActiveModPreset = { tag: string; mods: ActivePresetMod[] };

function validatePresetTag(tag: string): string {
  if (tag !== "fresh" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag)) {
    throw new Error("Preset tags must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens");
  }
  return tag;
}

function validatePresetModId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error("Each preset entry needs a valid Fabric modId");
  }
  return value;
}

function validatePresetJarName(value: unknown): string {
  if (typeof value !== "string" || value.length > 160 || value.includes("/") || value.includes("\\")
    || basename(value) !== value || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,155}\.jar$/i.test(value)) {
    throw new Error("Preset JAR entries must be simple .jar filenames from run/mod-library");
  }
  return value;
}

function presetStageFileName(modId: string, sha256: string): string {
  return `mcp-preset-${modId}-${sha256}.jar`;
}

async function readModPresetDefinitions(tag: string): Promise<PresetModSelection[]> {
  if (tag === "fresh") return [];

  let parsed: unknown;
  try {
    const configDetails = await lstat(modPresetsFile);
    if (!configDetails.isFile() || configDetails.isSymbolicLink() || configDetails.size > MAX_MOD_PRESET_CONFIG_BYTES) {
      throw new Error("The mod preset config must be a regular file no larger than 128 KiB");
    }
    parsed = JSON.parse(await readFile(modPresetsFile, "utf8"));
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("The mod preset config is missing; create run/config/minecraft-mcp/mod-presets.json and place its JARs in run/mod-library");
    }
    throw new Error("The mod preset config could not be parsed");
  }
  if (typeof parsed !== "object" || parsed === null || !("presets" in parsed)
    || typeof parsed.presets !== "object" || parsed.presets === null || Array.isArray(parsed.presets)) {
    throw new Error("The mod preset config must contain a presets object");
  }
  const presets = parsed.presets as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(presets, tag)) throw new Error(`Mod preset '${tag}' is not configured`);
  const configured = presets[tag];
  if (!Array.isArray(configured) || configured.length > 32) {
    throw new Error(`Mod preset '${tag}' must contain an array of at most 32 JAR entries`);
  }

  const seenFiles = new Set<string>();
  const seenModIds = new Set<string>();
  return configured.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("file" in entry) || !("modId" in entry)) {
      throw new Error(`Mod preset '${tag}' entries must contain file and modId`);
    }
    const file = validatePresetJarName(entry.file);
    const modId = validatePresetModId(entry.modId);
    if (seenFiles.has(file) || seenModIds.has(modId)) {
      throw new Error(`Mod preset '${tag}' cannot list a JAR filename or modId more than once`);
    }
    seenFiles.add(file);
    seenModIds.add(modId);
    return { file, modId };
  });
}

async function listConfiguredModPresets(): Promise<Array<{ tag: string; expectedModIds: string[]; files: string[] }>> {
  let parsed: unknown;
  try {
    const configDetails = await lstat(modPresetsFile);
    if (!configDetails.isFile() || configDetails.isSymbolicLink() || configDetails.size > MAX_MOD_PRESET_CONFIG_BYTES) {
      throw new Error("The mod preset config must be a regular file no larger than 128 KiB");
    }
    parsed = JSON.parse(await readFile(modPresetsFile, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error("The mod preset config could not be read");
  }
  if (typeof parsed !== "object" || parsed === null || !("presets" in parsed)
    || typeof parsed.presets !== "object" || parsed.presets === null || Array.isArray(parsed.presets)) {
    throw new Error("The mod preset config must contain a presets object");
  }
  const tags = Object.keys(parsed.presets as Record<string, unknown>);
  if (tags.length > 64) throw new Error("The mod preset config cannot contain more than 64 named presets");
  const results: Array<{ tag: string; expectedModIds: string[]; files: string[] }> = [
    { tag: "fresh", expectedModIds: [], files: [] },
  ];
  for (const tag of tags) {
    if (tag === "fresh") throw new Error("'fresh' is reserved and cannot be a named preset");
    validatePresetTag(tag);
    const mods = await readModPresetDefinitions(tag);
    results.push({ tag, expectedModIds: mods.map((mod) => mod.modId), files: mods.map((mod) => mod.file) });
  }
  return results;
}

async function readActiveModPreset(): Promise<ActiveModPreset | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(activeModPresetFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("tag" in parsed) || typeof parsed.tag !== "string"
      || !("mods" in parsed) || !Array.isArray(parsed.mods) || parsed.mods.length > 32) {
      throw new Error("The active mod preset registry is invalid; refusing to modify preset JARs.");
    }
    const tag = validatePresetTag(parsed.tag);
    const mods = parsed.mods.map((entry): ActivePresetMod => {
      if (typeof entry !== "object" || entry === null || !("stagedFile" in entry)
        || typeof entry.stagedFile !== "string" || !("sourceFile" in entry)
        || typeof entry.sourceFile !== "string" || !("modId" in entry)
        || typeof entry.modId !== "string" || !("sha256" in entry)
        || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !("sizeBytes" in entry) || typeof entry.sizeBytes !== "number"
        || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 4 || entry.sizeBytes > MAX_MOD_JAR_BYTES) {
        throw new Error("The active mod preset registry is invalid; refusing to modify preset JARs.");
      }
      const modId = validatePresetModId(entry.modId);
      const sourceFile = validatePresetJarName(entry.sourceFile);
      const stagedFile = presetStageFileName(modId, entry.sha256);
      if (entry.stagedFile !== stagedFile) throw new Error("The active mod preset registry contains an invalid staged filename.");
      return { stagedFile, sourceFile, modId, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
    });
    if (tag === "fresh" && mods.length > 0) throw new Error("The active fresh preset cannot contain additional mods.");
    return { tag, mods };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeActiveModPresetFiles(preset: ActiveModPreset): Promise<void> {
  const modsDirectory = resolve(gameDirectory, "mods");
  if (preset.mods.length > 0) {
    let directoryDetails;
    try { directoryDetails = await lstat(modsDirectory); }
    catch { throw new Error("The active mods directory is missing; refusing to remove preset JARs"); }
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) {
      throw new Error("The active mods path must be a regular directory; refusing to remove preset JARs");
    }
  }
  for (const mod of preset.mods) {
    const stagedPath = resolve(modsDirectory, mod.stagedFile);
    if (dirname(stagedPath) !== modsDirectory) throw new Error("The active mod preset contains an invalid path");
    try {
      const details = await lstat(stagedPath);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error("A staged preset JAR is no longer a regular file; refusing to remove it");
      if (await sha256File(stagedPath) !== mod.sha256) throw new Error("A staged preset JAR changed outside this MCP instance; refusing to remove it");
      await unlink(stagedPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  await unlink(activeModPresetFile).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

async function inspectPresetJar(file: string, modId: string): Promise<ActivePresetMod> {
  let libraryDetails;
  try { libraryDetails = await lstat(modLibraryDirectory); }
  catch { throw new Error("The per-instance run/mod-library folder does not exist"); }
  if (!libraryDetails.isDirectory() || libraryDetails.isSymbolicLink()) {
    throw new Error("The per-instance run/mod-library path must be a regular directory");
  }
  const sourcePath = resolve(modLibraryDirectory, file);
  if (dirname(sourcePath) !== modLibraryDirectory) throw new Error("Preset JAR path escaped its mod library");
  let sourceDetails;
  try { sourceDetails = await lstat(sourcePath); }
  catch { throw new Error(`Preset JAR '${file}' is missing from run/mod-library`); }
  if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) throw new Error(`Preset JAR '${file}' must be a regular file, not a symlink`);
  if (sourceDetails.size < 4 || sourceDetails.size > MAX_MOD_JAR_BYTES) throw new Error(`Preset JAR '${file}' must be between 4 bytes and 512 MiB`);

  const fileHandle = await open(sourcePath, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await fileHandle.read(signature, 0, signature.length, 0);
    if (bytesRead !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) throw new Error(`Preset file '${file}' is not a ZIP/JAR archive`);
  } finally {
    await fileHandle.close();
  }
  const sha256 = await sha256File(sourcePath);
  return { stagedFile: presetStageFileName(modId, sha256), sourceFile: file, modId, sha256, sizeBytes: sourceDetails.size };
}

async function writeActiveModPreset(preset: ActiveModPreset): Promise<void> {
  await mkdir(dirname(activeModPresetFile), { recursive: true });
  const temporary = `${activeModPresetFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(preset)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, activeModPresetFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function prepareModPreset(requestedTag: string): Promise<ActiveModPreset> {
  const tag = validatePresetTag(requestedTag);
  const definitions = await readModPresetDefinitions(tag);
  const previous = await readActiveModPreset();
  const modsDirectory = resolve(gameDirectory, "mods");
  await mkdir(modsDirectory, { recursive: true });
  const directoryDetails = await lstat(modsDirectory);
  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) {
    throw new Error("The active mods path must be a regular directory");
  }
  if (previous) await removeActiveModPresetFiles(previous);

  const staged: ActivePresetMod[] = [];
  try {
    for (const definition of definitions) {
      const mod = await inspectPresetJar(definition.file, definition.modId);
      const stagedPath = resolve(modsDirectory, mod.stagedFile);
      if (dirname(stagedPath) !== modsDirectory) throw new Error("Preset JAR path escaped the active mods folder");
      try {
        await lstat(stagedPath);
        throw new Error(`Managed preset filename '${mod.stagedFile}' already exists outside this preset registry`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const temporary = resolve(modsDirectory, `.${mod.stagedFile}.${randomUUID()}.tmp`);
      try {
        await copyFile(resolve(modLibraryDirectory, definition.file), temporary);
        if (await sha256File(temporary) !== mod.sha256) throw new Error(`Preset JAR '${definition.file}' changed while it was being staged`);
        await rename(temporary, stagedPath);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      staged.push(mod);
    }
    const active = { tag, mods: staged };
    await writeActiveModPreset(active);
    return active;
  } catch (error) {
    await removeActiveModPresetFiles({ tag, mods: staged }).catch(() => {});
    throw error;
  }
}

async function closeOwnedClientBeforeRestart(): Promise<"managed-closed" | "unmanaged" | "already-stopped"> {
  if (await isBridgeReachable()) {
    const status = await callBridge("/v1/status") as Record<string, unknown>;
    if (status.worldPresent === true) throw new Error("Leave the current world before restarting Minecraft with a different mod set");
    if (!managedRun) return "unmanaged";
    const stopped = await stopManagedRun(managedRun.id);
    if (stopped.stopped !== true) throw new Error("The managed Minecraft client could not be closed cleanly; no mod JAR was changed");
    return "managed-closed";
  }
  if (managedRun && childIsRunning(managedRun)) {
    throw new Error("Wait for the managed client's bridge to become ready before changing its mod set");
  }
  return "already-stopped";
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

async function waitForWorldReady(timeoutMs = 180_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    lastStatus = await callBridge("/v1/status") as Record<string, unknown>;
    if (lastStatus.worldReady === true) return lastStatus;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const screen = typeof lastStatus.screen === "string" ? lastStatus.screen : "unknown";
  const worldPresent = lastStatus.worldPresent === true;
  throw new Error(`World did not become ready within ${Math.round(timeoutMs / 1000)} seconds (screen=${screen}, worldPresent=${worldPresent})`);
}

function boundedUtf8Tail(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  let text = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  if (text.startsWith("\uFFFD")) text = text.slice(1);
  return { text: `[earlier log text truncated]\n${text}`, truncated: true };
}

function boundedLogText(value: string | null, maxLines: number): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const lineLimited = value.split(/\r?\n/).slice(-maxLines).join("\n");
  const bounded = boundedUtf8Tail(redactText(lineLimited), MAX_LOG_FIELD_RETURN_BYTES);
  return bounded;
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
    const token = await readToken();
    const response = await fetch(new URL("/v1/status", baseUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function gradleCommand(): { command: string; args: string[] } {
  const portProperty = `-Pminecraft_mcp_port=${bridgePort}`;
  if (process.platform === "win32") {
    const wrapper = resolve(projectRoot, "gradlew.bat");
    return { command: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", `"${wrapper}" ${portProperty} --console=plain runClient`] };
  }
  return { command: resolve(projectRoot, "gradlew"), args: [portProperty, "--console=plain", "runClient"] };
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

async function stopManagedRun(expectedRunId?: string): Promise<Record<string, unknown>> {
  const run = managedRun;
  if (expectedRunId && (!run || run.id !== expectedRunId)) {
    return {
      stopped: false,
      state: "run-id-mismatch",
      requestedRunId: expectedRunId,
      managedRunId: run?.id ?? null,
      message: "This MCP session did not launch a game with that run ID; no process was signaled.",
    };
  }
  if (!run) {
    const bridgeReady = await isBridgeReachable();
    return {
      stopped: false,
      state: bridgeReady ? "running-unmanaged" : "not-started",
      message: bridgeReady
        ? "A bridge is reachable, but this MCP session did not launch it; no process was signaled."
        : "No managed development client has been launched in this MCP session.",
    };
  }
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

async function startManagedGame(requestedPresetTag?: string): Promise<Record<string, unknown>> {
  if (launchInProgress) return { started: false, state: "starting", message: "A launch request is already being handled." };
  if (managedRun && childIsRunning(managedRun)) {
    return { started: false, runId: managedRun.id, state: processState(managedRun, await isBridgeReachable()),
      presetTag: managedRun.presetTag, message: "The managed development client is already running." };
  }
  const bridgeAlreadyReady = await isBridgeReachable();
  if (launchInProgress) return { started: false, state: "starting", message: "A launch request is already being handled." };
  if (managedRun && childIsRunning(managedRun)) {
    return { started: false, runId: managedRun.id, state: processState(managedRun, bridgeAlreadyReady),
      presetTag: managedRun.presetTag, message: "The managed development client is already running." };
  }
  if (bridgeAlreadyReady) {
    return { started: false, state: "running-unmanaged", bridgeReady: true,
      message: "A Minecraft-MCP client is already reachable but was not launched by this MCP session." };
  }

  launchInProgress = true;
  try {
    const priorPreset = requestedPresetTag === undefined ? await readActiveModPreset() : null;
    const presetTag = validatePresetTag(requestedPresetTag ?? priorPreset?.tag ?? "fresh");
    const activePreset = await prepareModPreset(presetTag);
    const launch = gradleCommand();
    const child = spawn(launch.command, launch.args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const run: ManagedRun = {
      id: randomUUID(), child, presetTag: activePreset.tag, expectedModIds: activePreset.mods.map((mod) => mod.modId),
      startedAt: new Date().toISOString(), exitCode: null, exitSignal: null,
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
    return { started: true, runId: run.id, state: "starting", task: "runClient", startedAt: run.startedAt,
      bridgePort, presetTag: run.presetTag, expectedModIds: run.expectedModIds,
      message: "Development client launch accepted. Poll get_game_process_status until bridgeReady is true." };
  } finally {
    launchInProgress = false;
  }
}

async function waitForManagedBridge(runId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = managedRun;
    if (!run || run.id !== runId) throw new Error("Managed game run changed while waiting for the bridge");
    if (await isBridgeReachable()) return;
    if (!childIsRunning(run)) throw new Error("The managed Minecraft client exited before its bridge became ready");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error("The managed Minecraft bridge did not become ready within three minutes");
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

server.registerTool("list_mod_presets", {
  description: "List the built-in fresh setup and named per-instance mod presets available to launch_game.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult({ presets: await listConfiguredModPresets() }); }
  catch (error) { return asToolError(error); }
});

server.registerTool("launch_game", {
  description: "Build and launch this repository's isolated Minecraft 26.3 Fabric development client with Minecraft-MCP already loaded. Use presetTag 'fresh' for the base development setup or a configured per-instance tag to add its selected mods. This starts only the fixed Gradle runClient task; poll get_game_process_status for bridge readiness.",
  inputSchema: {
    presetTag: z.string().regex(/^(?:fresh|[a-z0-9][a-z0-9_-]{0,63})$/).default("fresh")
      .describe("Use 'fresh' for no optional preset mods, or the name of a preset in run/config/minecraft-mcp/mod-presets.json"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ presetTag }) => {
  try { return buildResult(await startManagedGame(presetTag)); }
  catch (error) { return asToolError(error); }
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
      bridgePort,
      processManaged: run !== null,
      runId: run?.id ?? null,
      presetTag: run?.presetTag ?? null,
      expectedModIds: run?.expectedModIds ?? [],
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
  description: "Gracefully stop only the Minecraft development client launched by this MCP server. Uses bounded signal escalation and will not stop an unmanaged client.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return buildResult(await stopManagedRun()); }
  catch (error) { return asToolError(error); }
});

server.registerTool("close_game", {
  description: "Close only the Minecraft game process launched by this MCP session. An optional runId must exactly match the ID returned by launch_game. Unmanaged or mismatched Minecraft clients are never signaled.",
  inputSchema: { runId: z.string().uuid().optional().describe("Optional exact run ID returned by launch_game; a mismatch refuses to close anything") },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ runId }) => {
  try { return buildResult(await stopManagedRun(runId)); }
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
    const boundedGameLog = boundedLogText(gameLog, maxLines);
    const boundedLauncherOutput = boundedLogText(launcherOutput, maxLines);
    const value = {
      gameLog: boundedGameLog.text,
      launcherOutput: boundedLauncherOutput.text,
      outputTruncated: boundedGameLog.truncated || boundedLauncherOutput.truncated,
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
  try {
    const performance = await callBridge("/v1/performance") as Record<string, unknown>;
    const activePreset = managedRun
      ? { tag: managedRun.presetTag, expectedModIds: managedRun.expectedModIds }
      : { tag: null, expectedModIds: [] as string[] };
    const loadedMods = Array.isArray(performance.loadedMods) ? performance.loadedMods as Record<string, unknown>[] : [];
    const loadedModIds = new Set(loadedMods.map((mod) => mod.id).filter((id): id is string => typeof id === "string"));
    const loadedPresetModIds = activePreset.expectedModIds.filter((id) => loadedModIds.has(id));
    const missingPresetModIds = activePreset.expectedModIds.filter((id) => !loadedModIds.has(id));
    const loadedModListComplete = Array.isArray(performance.loadedMods) && performance.loadedModsTruncated === false;
    const presetVerification = activePreset.expectedModIds.length === 0 ? "not-required"
      : !loadedModListComplete ? "loaded-mod-list-incomplete"
      : missingPresetModIds.length === 0 ? "verified-loaded"
      : "expected-mod-not-found";
    return buildResult({ ...performance, presetTag: activePreset.tag,
      expectedPresetModIds: activePreset.expectedModIds, loadedPresetModIds, missingPresetModIds,
      presetVerification });
  }
  catch (error) { return asToolError(error); }
});

server.registerTool("get_menu_state", {
  description: "Inspect the current menu and visible controls. Use returned labels with run_menu_actions, or use indexes only with the returned screenRevision for single-control tools. Input tools return the resulting menu state.",
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
  description: "Click a visible control and return the resulting menu state in one call. Requires the current screenRevision. Refuses stale revisions, hidden/disabled controls, and destructive world-management actions. Use load_world_snapshot for existing saves.",
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
  description: "Set a visible text field by its index from get_menu_state, verify the text was accepted, and return the updated menu state.",
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
  description: "Tap one allowlisted key using Minecraft's SDL key/scancode pair and return the resulting menu state. Reports handled and observed state changes separately. Enter and Space are disabled on saved-world selection; use load_world_snapshot instead.",
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

const menuKeySchema = z.enum(["enter", "escape", "tab", "up", "down", "left", "right", "space", "backspace"]);
const menuActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), label: z.string().min(1).max(160), screen: z.string().max(80).optional() }),
  z.object({ type: z.literal("text"), label: z.string().min(1).max(160), value: z.string().max(128), screen: z.string().max(80).optional() }),
  z.object({ type: z.literal("key"), key: menuKeySchema, screen: z.string().max(80).optional() }),
]);

server.registerTool("run_menu_actions", {
  description: "Run up to eight safe menu actions in sequence using visible control labels and return every intermediate result plus the final menu state. This batches UI navigation and avoids separate get_menu_state calls between steps.",
  inputSchema: { actions: z.array(menuActionSchema).min(1).max(8) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ actions }) => {
  const steps: Record<string, unknown>[] = [];
  try {
    let menu = await callBridge("/v1/ui") as Record<string, unknown>;
    for (let stepIndex = 0; stepIndex < actions.length; stepIndex++) {
      const action = actions[stepIndex]!;
      const screen = String(menu.screen ?? "none");
      const revision = Number(menu.screenRevision);
      if (!Number.isSafeInteger(revision) || screen === "none") throw new Error("There is no active menu for the next action");
      if (action.screen && action.screen !== screen) {
        throw new Error(`Step ${stepIndex + 1} expected ${action.screen} but the current screen is ${screen}`);
      }

      let result: Record<string, unknown>;
      if (action.type === "key") {
        result = await callBridge("/v1/ui/key", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ screenRevision: revision, key: action.key }),
        }) as Record<string, unknown>;
      } else {
        const controls = Array.isArray(menu.controls) ? menu.controls as Record<string, unknown>[] : [];
        const matches = controls.filter((control) => control.label === action.label
          && (action.type !== "text" || control.type === "EditBox"));
        if (matches.length !== 1) throw new Error(`Step ${stepIndex + 1} expected one visible control labeled ${action.label}, found ${matches.length}`);
        const index = Number(matches[0]!.index);
        const endpoint = action.type === "click" ? "/v1/ui/click" : "/v1/ui/text";
        const body = action.type === "click"
          ? { screenRevision: revision, index }
          : { screenRevision: revision, index, value: action.value };
        result = await callBridge(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }) as Record<string, unknown>;
      }
      menu = result.menu && typeof result.menu === "object"
        ? result.menu as Record<string, unknown>
        : await callBridge("/v1/ui") as Record<string, unknown>;
      const actionSummary = action.type === "text"
        ? { type: action.type, label: action.label, valueLength: action.value.length, screen: action.screen ?? null }
        : action;
      steps.push({ step: stepIndex + 1, action: actionSummary, accepted: result.accepted === true,
        changed: result.changed ?? result.verified ?? null, screen: menu.screen });
    }
    return buildResult({ completed: true, steps, menu });
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    return { ...buildResult({ completed: false, steps, error: message }), isError: true };
  }
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
  description: "Hold one movement key for up to 40 ticks, release it automatically, and return before/after player coordinates in the same call. Requires a ready world and no menu.",
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
  description: "Briefly use the selected item or interact with the targeted block/entity, wait for automatic release, and return the resulting game status. Maximum duration is 20 ticks. Use disposable worlds for actions that may change world state.",
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

server.registerTool("run_command", {
  description: "Send one Minecraft slash command to an MCP-generated disposable local single-player world. A leading slash is optional. Commands are bounded to 256 characters and are never sent to multiplayer servers or ordinary saves.",
  inputSchema: {
    command: z.string().min(1).max(256).refine((command) => ![...command].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }), { message: "Command cannot contain control characters" }),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ command }) => {
  try {
    return buildResult(await callBridge("/v1/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    }) as Record<string, unknown>);
  } catch (error) { return asToolError(error); }
});

server.registerTool("load_mod_jar", {
  description: "Copy a user-selected, already-built Fabric mod JAR into this repository's isolated run/mods folder and restart this MCP's managed Minecraft 26.3 client to load it. This does not build or launch the JAR's source project. Pass its Fabric mod ID from fabric.mod.json as expectedModId to verify it appears in Fabric's loaded-mod list. loaded is null unless the expected ID is supplied and the list is complete; this avoids claiming success without evidence or claiming absence from a truncated list. An unmanaged client is left running and the result says restartRequired. The source path is used for this call only and is not stored in global configuration.",
  inputSchema: {
    jarPath: z.string().min(1).max(4096).describe("Absolute path to one local .jar file; it is copied into this MCP instance's isolated run directory"),
    expectedModId: z.string().regex(/^[a-z0-9_.-]+$/).optional().describe("Fabric mod ID from the selected JAR's fabric.mod.json; when supplied, load_mod_jar verifies that ID appears in the loaded mod list"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ jarPath, expectedModId }) => {
  try {
    if (process.env.MINECRAFT_MCP_URL || process.env.MINECRAFT_MCP_TOKEN_FILE) {
      throw new Error("JAR loading is available only for this MCP instance's isolated runClient profile");
    }
    const clientState = await closeOwnedClientBeforeRestart();
    const stagedJar = await stageTargetModJar(jarPath);
    if (clientState === "unmanaged") {
      return buildResult({ loaded: null, verification: "not-run-client-unmanaged", expectedModLoaded: null,
        expectedModId: expectedModId ?? null, staged: true, restartRequired: true,
        message: "The JAR is staged in this project directory. The running client belongs to another MCP session and was left untouched.",
        jar: { sourceName: stagedJar.sourceName, sizeBytes: stagedJar.sizeBytes,
          sha256Prefix: stagedJar.sha256.slice(0, 16), alreadyStaged: stagedJar.alreadyStaged } });
    }
    const started = await startManagedGame();
    if (started.started !== true || typeof started.runId !== "string") {
      throw new Error("The JAR was staged, but this MCP instance could not start its managed Minecraft client");
    }
    await waitForManagedBridge(started.runId);
    const performance = await callBridge("/v1/performance") as Record<string, unknown>;
    const loadedMods = Array.isArray(performance.loadedMods) ? performance.loadedMods as Record<string, unknown>[] : [];
    const loadedMod = expectedModId ? loadedMods.find((mod) => mod.id === expectedModId) : undefined;
    const verification = !expectedModId ? "not-requested"
      : loadedMod ? "verified-loaded"
      : performance.loadedModsTruncated === false ? "expected-mod-not-found"
      : "loaded-mod-list-incomplete";
    const expectedLoaded = verification === "verified-loaded" ? true
      : verification === "expected-mod-not-found" ? false
      : null;
    return buildResult({
      loaded: expectedLoaded,
      verification,
      expectedModLoaded: expectedLoaded,
      expectedModId: expectedModId ?? null,
      loadedMod: loadedMod ? { id: loadedMod.id, version: loadedMod.version } : null,
      loadedModCount: typeof performance.loadedModCount === "number" ? performance.loadedModCount : loadedMods.length,
      loadedModsTruncated: performance.loadedModsTruncated ?? null,
      jar: { sourceName: stagedJar.sourceName, sizeBytes: stagedJar.sizeBytes, sha256Prefix: stagedJar.sha256.slice(0, 16), alreadyStaged: stagedJar.alreadyStaged },
      bridgeReady: true,
      runId: started.runId,
      minecraftVersion: performance.minecraftVersion,
    });
  } catch (error) { return asToolError(error); }
});

server.registerTool("unload_mod_jar", {
  description: "Remove only the JAR staged by load_mod_jar from this MCP instance. If its managed client is running, it must be at a menu; the tool closes that exact managed process before removing the JAR.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    if (process.env.MINECRAFT_MCP_URL || process.env.MINECRAFT_MCP_TOKEN_FILE) {
      throw new Error("JAR unloading is available only for this MCP instance's isolated runClient profile");
    }
    const clientState = await closeOwnedClientBeforeRestart();
    const unloaded = await removeStagedTargetModJar();
    if (!unloaded.removed) return buildResult({ removed: false, message: "This MCP instance has no staged test JAR." });
    if (clientState === "unmanaged") {
      return buildResult({ removed: true, restarted: false, restartRequired: true,
        sourceName: unloaded.sourceName, message: "The JAR was removed. The running client belongs to another MCP session and was left untouched." });
    }
    const started = await startManagedGame();
    if (started.started !== true || typeof started.runId !== "string") {
      return buildResult({ removed: true, restarted: false, sourceName: unloaded.sourceName, state: started.state });
    }
    await waitForManagedBridge(started.runId);
    return buildResult({ removed: true, restarted: true, sourceName: unloaded.sourceName, bridgeReady: true, runId: started.runId });
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
  description: "Create a unique normal-terrain test world and wait for worldReady before returning its ID and final status. Use the menu tools to exercise the actual Create World interface. Requires no active world; an optional integer seed makes terrain reproducible.",
  inputSchema: { seed: z.number().int().safe().optional().describe("Optional deterministic world seed") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ seed }) => {
  try {
    const created = await callBridge("/v1/worlds/create-test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seed === undefined ? {} : { seed }),
    }) as Record<string, unknown>;
    const status = await waitForWorldReady();
    return buildResult({ ...created, worldReady: true, status });
  } catch (error) { return asToolError(error); }
});

server.registerTool("leave_test_world", {
  description: "Save and leave the current local single-player world, then return the final title-screen status in one call. Use a disposable test world or copied snapshot. Does not disconnect from multiplayer servers.",
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
    const loaded = await callBridge("/v1/worlds/load-snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>;
    const status = await waitForWorldReady();
    return buildResult({ ...loaded, worldReady: true, status });
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
    const opened = await callBridge("/v1/worlds/open-generated", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId }),
    }) as Record<string, unknown>;
    const status = await waitForWorldReady();
    return buildResult({ ...opened, worldReady: true, status });
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
  await initializeBridgeEndpoint();
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
