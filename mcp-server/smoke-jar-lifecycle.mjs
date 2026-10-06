import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, "..");
const probeJar = resolve(projectRoot, "build/smoke-mod/mcp-smoke-probe.jar");
const client = new Client({ name: "minecraft-mcp-jar-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "mcp-server/dist/index.js")],
  cwd: projectRoot,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const message = result.content?.find((entry) => entry.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`${name} failed: ${message}`);
  }
  return result.structuredContent;
}

let managedRunId = null;
let generatedWorldId = null;
let closed = false;

async function main() {
  await client.connect(transport);
  const existingProcess = await callTool("get_game_process_status");
  if (existingProcess.bridgeReady === true && existingProcess.processManaged !== true) {
    const performance = await callTool("get_game_performance");
    const probeLoaded = performance.loadedMods?.some((mod) => mod.id === "mcp_smoke_probe") === true;
    if (probeLoaded) {
      const unloaded = await callTool("unload_mod_jar");
      assert(unloaded.removed === true && unloaded.restartRequired === true,
        "The unmanaged-client cleanup branch did not remove only the staged smoke JAR");
      console.log(JSON.stringify({ passed: true, jarLoadedByFabric: true, jarUnloadedFromInstance: true, restartRequired: true }, null, 2));
    } else {
      const staged = await callTool("load_mod_jar", { jarPath: probeJar, expectedModId: "mcp_smoke_probe" });
      assert(staged.staged === true && staged.restartRequired === true && staged.loaded === null,
        "The unmanaged-client branch did not stage the JAR without claiming it was loaded");
      console.log(JSON.stringify({ passed: true, jarStaged: true, unmanagedClientUntouched: true, restartRequired: true }, null, 2));
    }
    return;
  }

  const start = await callTool("launch_game");
  assert(start.started === true && typeof start.runId === "string", "The MCP adapter did not launch its managed client");
  managedRunId = start.runId;

  const deadline = Date.now() + 180_000;
  let processStatus;
  while (Date.now() < deadline) {
    processStatus = await callTool("get_game_process_status");
    if (processStatus.bridgeReady === true) break;
    if (["crashed", "failed-to-start"].includes(processStatus.state)) throw new Error(`Client launch failed: ${processStatus.state}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  }
  assert(processStatus?.bridgeReady === true, "The managed client bridge did not become ready");

  const loaded = await callTool("load_mod_jar", { jarPath: probeJar, expectedModId: "mcp_smoke_probe" });
  managedRunId = loaded.runId;
  assert(loaded.loaded === true && loaded.expectedModLoaded === true, "The supplied smoke JAR was not loaded by Fabric");
  assert(loaded.loadedMod?.id === "mcp_smoke_probe", "The smoke mod ID was absent from the loaded-mod result");

  const created = await callTool("create_test_world", { seed: 42 });
  generatedWorldId = created.status?.worldId;
  assert(created.worldReady === true && created.status?.generatedByMcp === true,
    "The smoke world was not ready and registered as generated");

  const command = await callTool("run_command", { command: "/time query daytime" });
  assert(command.accepted === true && command.worldId === generatedWorldId,
    "The slash command was not dispatched to the local generated world");

  const left = await callTool("leave_test_world");
  assert(left.returnedToTitle === true && left.status?.screen === "TitleScreen", "The smoke world did not return to title");
  const cleanup = await callTool("cleanup_generated_world", { worldId: generatedWorldId });
  assert(cleanup.deleted === true, "The smoke world was not cleaned up");
  generatedWorldId = null;

  const unloaded = await callTool("unload_mod_jar");
  managedRunId = unloaded.runId;
  assert(unloaded.removed === true && unloaded.restarted === true, "The staged smoke JAR was not removed cleanly");

  const closedResult = await callTool("close_game", { runId: managedRunId });
  assert(closedResult.stopped === true && closedResult.state === "stopped", "close_game did not close its exact managed run");
  managedRunId = null;
  closed = true;

  console.log(JSON.stringify({
    passed: true,
    jarLoaded: true,
    slashCommandSent: true,
    generatedWorldCleaned: true,
    jarUnloaded: true,
    exactManagedRunClosed: true,
  }, null, 2));
}

main().catch(async (error) => {
  if (generatedWorldId) {
    try {
      const status = await callTool("get_game_status");
      if (status.singleplayer === true) await callTool("leave_test_world");
      await callTool("cleanup_generated_world", { worldId: generatedWorldId });
    } catch { /* Preserve the primary failure; cleanup remains limited to our returned generated ID. */ }
  }
  if (managedRunId) {
    try { await callTool("close_game", { runId: managedRunId }); }
    catch { /* The run may already have exited. */ }
  }
  console.error(`JAR lifecycle smoke test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}).finally(async () => {
  await client.close().catch(() => {});
  if (closed) process.exitCode = 0;
});
