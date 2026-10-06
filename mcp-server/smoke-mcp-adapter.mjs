import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "minecraft-mcp-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "mcp-server/dist/index.js")],
  cwd: projectRoot,
});
let generatedWorldId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifySecondInstanceIsolation(primaryBridgePort) {
  const profileRoot = await mkdtemp(resolve(dirname(fileURLToPath(import.meta.url)), ".port-isolation-"));
  const moduleRoot = resolve(profileRoot, "mcp-server");
  const distributionRoot = resolve(moduleRoot, "dist");
  const isolatedEntry = resolve(distributionRoot, "index.js");
  const isolatedClient = new Client({ name: "minecraft-mcp-port-isolation-smoke", version: "1.0.0" });
  const isolatedEnvironment = { ...process.env };
  delete isolatedEnvironment.MINECRAFT_MCP_URL;
  delete isolatedEnvironment.MINECRAFT_MCP_TOKEN_FILE;

  try {
    await mkdir(distributionRoot, { recursive: true });
    await writeFile(resolve(profileRoot, "package.json"), '{"type":"module"}\n', "utf8");
    await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), "dist/index.js"), isolatedEntry);
    const isolatedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [isolatedEntry],
      cwd: profileRoot,
      env: isolatedEnvironment,
    });
    await isolatedClient.connect(isolatedTransport);
    const isolatedStatus = await isolatedClient.callTool({ name: "get_game_process_status", arguments: {} });
    const isolatedPort = isolatedStatus.structuredContent?.bridgePort;
    assert(isolatedStatus.structuredContent?.bridgeReady === false, "Second project instance attached to a running bridge");
    assert(Number.isInteger(isolatedPort) && isolatedPort !== primaryBridgePort,
      "Second project instance did not receive its own bridge port");
    const primaryStatus = await client.callTool({ name: "get_game_status", arguments: {} });
    assert(primaryStatus.structuredContent?.screen === "TitleScreen", "Second project instance disturbed the primary game");
    return { isolatedPort };
  } finally {
    await isolatedClient.close().catch(() => {});
    await rm(profileRoot, { recursive: true, force: true });
  }
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  assert(toolNames.has("run_menu_actions"), "run_menu_actions was not registered by the stdio adapter");
  assert(toolNames.has("press_menu_key"), "press_menu_key was not registered by the stdio adapter");
  assert(toolNames.has("create_test_world") && toolNames.has("leave_test_world")
    && toolNames.has("cleanup_generated_world"), "World lifecycle tools were not registered by the stdio adapter");
  assert(toolNames.has("close_game") && toolNames.has("run_command"), "close_game or run_command was not registered by the stdio adapter");

  const mismatchedClose = await client.callTool({
    name: "close_game",
    arguments: { runId: "00000000-0000-4000-8000-000000000000" },
  });
  assert(mismatchedClose.structuredContent?.stopped === false
    && mismatchedClose.structuredContent?.state === "run-id-mismatch",
  "close_game did not refuse a run ID owned by another MCP session");
  const afterMismatchedClose = await client.callTool({ name: "get_game_status", arguments: {} });
  assert(afterMismatchedClose.structuredContent?.screen === "TitleScreen",
    "A mismatched close_game call affected the unrelated Minecraft client");
  assert(toolNames.has("get_recent_logs") && toolNames.has("get_game_performance"), "Diagnostics tools were not registered by the stdio adapter");

  const stateResult = await client.callTool({ name: "get_menu_state", arguments: {} });
  const menu = stateResult.structuredContent;
  assert(menu?.screen === "TitleScreen", `Expected TitleScreen, got ${menu?.screen ?? "unknown"}`);
  const primaryProcess = await client.callTool({ name: "get_game_process_status", arguments: {} });
  const primaryBridgePort = primaryProcess.structuredContent?.bridgePort;
  assert(Number.isInteger(primaryBridgePort), "Primary project did not report its per-instance bridge port");
  const { isolatedPort } = await verifySecondInstanceIsolation(primaryBridgePort);

  const actionsResult = await client.callTool({
    name: "run_menu_actions",
    arguments: {
      actions: [
        { type: "click", label: "Singleplayer", screen: "TitleScreen" },
        { type: "key", key: "escape", screen: "SelectWorldScreen" },
      ],
    },
  });
  const actions = actionsResult.structuredContent;
  assert(actionsResult.isError !== true, "Batched menu action returned an MCP error");
  assert(actions?.completed === true && actions.steps?.length === 2, "Batched menu action did not report both completed steps");
  assert(actions.menu?.screen === "TitleScreen", `Batched actions ended on ${actions.menu?.screen ?? "unknown"}`);

  const createMenuResult = await client.callTool({ name: "open_create_world_menu", arguments: {} });
  assert(createMenuResult.isError !== true, "Create World menu did not open through the MCP adapter");
  const formActionsResult = await client.callTool({
    name: "run_menu_actions",
    arguments: {
      actions: [
        { type: "text", label: "World Name", value: "MCP Batch", screen: "CreateWorldScreen" },
        { type: "key", key: "backspace", screen: "CreateWorldScreen" },
        { type: "key", key: "escape", screen: "CreateWorldScreen" },
        { type: "key", key: "escape", screen: "SelectWorldScreen" },
      ],
    },
  });
  const formActions = formActionsResult.structuredContent;
  assert(formActionsResult.isError !== true && formActions?.completed === true
    && formActions.steps?.length === 4,
  `Batched text/key menu actions did not complete: ${formActions?.error ?? formActionsResult.content?.[0]?.text ?? "unknown error"}`);
  assert(formActions.menu?.screen === "TitleScreen", "Batched form actions did not return to title");
  assert(!("value" in formActions.steps[0].action), "Batched text action echoed entered text into tool output");

  const diagnostics = await client.callTool({ name: "get_recent_logs", arguments: { maxLines: 20 } });
  const diagnosticData = diagnostics.structuredContent;
  assert(diagnostics.isError !== true, "Bounded diagnostics call failed");
  assert(Buffer.byteLength(diagnosticData.gameLog ?? "", "utf8") <= 7 * 1024
    && Buffer.byteLength(diagnosticData.launcherOutput ?? "", "utf8") <= 7 * 1024,
  "Recent logs exceeded the per-field byte bound");
  const performance = await client.callTool({ name: "get_game_performance", arguments: {} });
  assert(performance.structuredContent?.minecraftVersion === "26.3", "Performance output returned the wrong Minecraft version");

  const worldResult = await client.callTool({ name: "create_test_world", arguments: { seed: 42 } });
  const createdWorld = worldResult.structuredContent;
  assert(worldResult.isError !== true && createdWorld?.worldReady === true, "create_test_world returned before the world became ready");
  generatedWorldId = createdWorld?.status?.worldId;
  assert(typeof generatedWorldId === "string" && generatedWorldId.startsWith("mcp_test_")
    && createdWorld.status.generatedByMcp === true, "create_test_world returned an invalid or untracked world ID");
  assert(String(createdWorld.status.gameMode).toLowerCase() === "survival", "The slash-command smoke world did not start in Survival");

  const commandResult = await client.callTool({ name: "run_command", arguments: { command: "/gamemode creative" } });
  assert(commandResult.isError !== true && commandResult.structuredContent?.accepted === true
    && commandResult.structuredContent?.worldId === generatedWorldId
    && commandResult.structuredContent?.status?.worldReady === true,
  `Slash command was not sent to the generated local world: ${JSON.stringify(commandResult)}`);
  const commandDeadline = Date.now() + 10_000;
  let changedStatus = commandResult.structuredContent.status;
  while (Date.now() < commandDeadline && String(changedStatus.gameMode).toLowerCase() !== "creative") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    changedStatus = (await client.callTool({ name: "get_game_status", arguments: {} })).structuredContent;
  }
  assert(String(changedStatus.gameMode).toLowerCase() === "creative", "The slash command did not change Survival to Creative");

  const leaveResult = await client.callTool({ name: "leave_test_world", arguments: {} });
  const leftWorld = leaveResult.structuredContent;
  assert(leaveResult.isError !== true && leftWorld?.returnedToTitle === true
    && leftWorld.status?.screen === "TitleScreen", "leave_test_world did not wait for the title screen");

  const cleanupResult = await client.callTool({ name: "cleanup_generated_world", arguments: { worldId: generatedWorldId } });
  assert(cleanupResult.isError !== true && cleanupResult.structuredContent?.deleted === true,
    "Generated test world was not cleaned up through the MCP tool");
  generatedWorldId = null;

  console.log(JSON.stringify({
    passed: true,
    tools: ["get_menu_state", "run_menu_actions", "get_recent_logs", "get_game_performance", "run_command", "close_game", "create_test_world", "leave_test_world", "cleanup_generated_world"],
    menuSteps: [
      ...actions.steps.map((step) => ({ ...step, phase: "title" })),
      ...formActions.steps.map((step) => ({ ...step, phase: "create-world-form", step: step.step + actions.steps.length })),
    ],
    worldReady: createdWorld.worldReady,
    gameModeAfterCommand: changedStatus.gameMode,
    primaryBridgePort,
    isolatedBridgePort: isolatedPort,
    returnedToTitle: leftWorld.returnedToTitle,
    cleanedTestWorld: true,
  }, null, 2));
} catch (error) {
  if (generatedWorldId) {
    try {
      const status = (await client.callTool({ name: "get_game_status", arguments: {} })).structuredContent;
      if (status?.singleplayer === true) await client.callTool({ name: "leave_test_world", arguments: {} });
      const current = (await client.callTool({ name: "get_game_status", arguments: {} })).structuredContent;
      if (current?.worldPresent === false && current.screen === "TitleScreen") {
        await client.callTool({ name: "cleanup_generated_world", arguments: { worldId: generatedWorldId } });
      }
    } catch { /* Only the exact generated ID returned by create_test_world is eligible here. */ }
  }
  console.error(`MCP adapter smoke test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
