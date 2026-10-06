import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let baseUrl = process.env.MINECRAFT_MCP_URL ?? "";
const tokenFile = process.env.MINECRAFT_MCP_TOKEN_FILE
  ?? resolve(projectRoot, "run/config/minecraft-mcp/bridge-token.txt");
const bridgePortFile = resolve(projectRoot, "run/config/minecraft-mcp/bridge-port.txt");
const keyNames = ["enter", "escape", "tab", "up", "down", "left", "right", "space", "backspace"];

async function initializeBaseUrl() {
  if (baseUrl) return;
  let port = 8765;
  try {
    const configured = Number((await readFile(bridgePortFile, "utf8")).trim());
    if (Number.isInteger(configured) && configured >= 1024 && configured <= 65535) port = configured;
  } catch { /* Default to the first-run bridge port. */ }
  baseUrl = `http://127.0.0.1:${port}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path.includes("/worlds/") ? 180_000 : 15_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${value?.error ?? "unknown bridge error"}`);
  return value;
}

async function getMenu() {
  return request("/v1/ui");
}

function findControl(menu, predicate, label) {
  const matches = menu.controls.filter(predicate);
  assert(matches.length === 1, `Expected one ${label}, found ${matches.length}`);
  return matches[0];
}

async function press(menu, key) {
  assert(keyNames.includes(key), `Unsupported smoke-test key: ${key}`);
  const result = await request("/v1/ui/key", { screenRevision: menu.screenRevision, key });
  assert(result.accepted === true, `Key ${key} was not accepted by ${menu.screen}`);
  assert(result.menu && typeof result.menu === "object", `Key ${key} did not return resulting menu state`);
  return result.menu;
}

async function click(menu, control) {
  const result = await request("/v1/ui/click", { screenRevision: menu.screenRevision, index: control.index });
  assert(result.accepted === true && result.verified === true, `Click ${control.label} was not verified`);
  assert(result.menu && typeof result.menu === "object", `Click ${control.label} did not return resulting menu state`);
  return result.menu;
}

async function setText(menu, control, value) {
  const result = await request("/v1/ui/text", { screenRevision: menu.screenRevision, index: control.index, value });
  assert(result.accepted === true && result.verified === true, `Text update ${control.label} was not verified`);
  assert(result.menu && typeof result.menu === "object", `Text update ${control.label} did not return resulting menu state`);
  return result.menu;
}

async function cycleTo(menu, prefix, targetLabel, maxSteps = 8) {
  for (let attempt = 0; attempt < maxSteps; attempt++) {
    const option = findControl(menu, (control) => control.type === "CycleButton"
      && String(control.label).startsWith(prefix), `${prefix} option`);
    if (option.label === targetLabel) return menu;
    assert(option.active, `${option.label} is disabled before reaching ${targetLabel}`);
    menu = await click(menu, option);
  }
  const finalOption = menu.controls.find((control) => control.type === "CycleButton" && String(control.label).startsWith(prefix));
  assert(finalOption?.label === targetLabel, `Could not return ${prefix} to ${targetLabel}`);
  return menu;
}

async function waitForWorldReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = {};
  while (Date.now() < deadline) {
    lastStatus = await request("/v1/status");
    if (lastStatus.worldReady === true) return lastStatus;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`World readiness timed out on screen ${lastStatus.screen ?? "unknown"}`);
}

let token;
let testWorldId = null;
let createdWorldReady = false;
const results = [];

async function main() {
  await initializeBaseUrl();
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("MINECRAFT_MCP_URL must use plain HTTP on the local loopback interface");
  }
  token = (await readFile(tokenFile, "utf8")).trim();
  assert(token.length > 0, "Bridge token file is empty");

  const initialStatus = await request("/v1/status");
  assert(initialStatus.connected === false && initialStatus.worldPresent === false, "Client must be at a menu with no active world");
  let menu = await getMenu();
  if (menu.screen === "AccessibilityOnboardingScreen") {
    menu = await click(menu, findControl(menu, (control) => control.label === "Continue", "Continue button"));
  }
  assert(menu.screen === "TitleScreen", `Expected TitleScreen, got ${menu.screen}`);

  menu = await click(menu, findControl(menu, (control) => control.label === "Singleplayer", "Singleplayer button"));
  assert(menu.screen === "SelectWorldScreen", `Singleplayer click did not open SelectWorldScreen (${menu.screen})`);
  menu = await press(menu, "escape");
  assert(menu.screen === "TitleScreen", `Escape did not return to title (${menu.screen})`);
  results.push("title click and Escape navigation");

  const openCreate = await request("/v1/ui/open-create-world", {});
  assert(openCreate.accepted === true, "Create World screen did not open");
  menu = await getMenu();
  assert(menu.screen === "CreateWorldScreen", `Expected CreateWorldScreen, got ${menu.screen}`);

  const editBox = findControl(menu, (control) => control.type === "EditBox", "world name field");
  const worldName = `MCP${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  menu = await setText(menu, editBox, worldName);

  let currentEditBox = findControl(menu, (control) => control.type === "EditBox", "world name field");
  menu = await press(menu, "backspace");
  currentEditBox = findControl(menu, (control) => control.type === "EditBox", "world name field after Backspace");
  assert(currentEditBox.textLength === worldName.length - 1, "Backspace did not delete the final character");

  menu = await setText(menu, currentEditBox, worldName);
  currentEditBox = findControl(menu, (control) => control.type === "EditBox", "world name field before cursor test");
  const cursorAtEnd = currentEditBox.cursorPosition;
  menu = await press(menu, "left");
  currentEditBox = findControl(menu, (control) => control.type === "EditBox", "world name field after Left");
  assert(currentEditBox.cursorPosition === cursorAtEnd - 1, "Left did not move the text cursor");
  menu = await press(menu, "right");
  currentEditBox = findControl(menu, (control) => control.type === "EditBox", "world name field after Right");
  assert(currentEditBox.cursorPosition === cursorAtEnd, "Right did not move the text cursor");

  const focusedBeforeTab = menu.controls.find((control) => control.focused)?.index;
  menu = await press(menu, "tab");
  const focusedAfterTab = menu.controls.find((control) => control.focused)?.index;
  assert(focusedAfterTab !== undefined && focusedAfterTab !== focusedBeforeTab, "Tab did not move menu focus");

  for (const key of ["up", "down"]) {
    const before = menu.controls.find((control) => control.focused)?.index;
    menu = await press(menu, key);
    const after = menu.controls.find((control) => control.focused)?.index;
    assert(after !== undefined && after !== before, `${key} did not move menu focus`);
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const focused = menu.controls.find((control) => control.focused);
    if (focused?.type === "CycleButton") break;
    menu = await press(menu, "tab");
  }
  let focusedCycle = menu.controls.find((control) => control.type === "CycleButton" && control.focused);
  assert(focusedCycle, "Tab could not focus a Create World option");
  const cycleLabelBeforeSpace = focusedCycle.label;
  menu = await press(menu, "space");
  focusedCycle = menu.controls.find((control) => control.type === "CycleButton" && control.focused);
  assert(focusedCycle && focusedCycle.label !== cycleLabelBeforeSpace, "Space did not activate the focused option");

  menu = await cycleTo(menu, "Game Mode:", "Game Mode: Survival");
  menu = await cycleTo(menu, "Difficulty:", "Difficulty: Normal");
  const toggle = menu.controls.find((control) => control.type === "CycleButton" && String(control.label).startsWith("Allow Commands:"));
  assert(toggle, "Allow Commands option was not visible");
  menu = await click(menu, toggle);
  const toggleAfterClick = findControl(menu, (control) => control.type === "CycleButton"
    && String(control.label).startsWith("Allow Commands:"), "Allow Commands option after click");
  assert(toggleAfterClick.label !== toggle.label, "Mouse click did not activate the Allow Commands option");
  results.push("Tab/arrows/Space/Backspace/Left/Right and verified mouse click");

  const createButton = findControl(menu, (control) => control.label === "Create New World", "Create New World button");
  menu = await click(menu, createButton);
  const readyStatus = await waitForWorldReady();
  testWorldId = readyStatus.worldId;
  createdWorldReady = true;
  assert(typeof testWorldId === "string" && testWorldId.length > 0 && testWorldId !== ".", "Active world ID was not normalized");
  assert(readyStatus.generatedByMcp === true, "Vanilla Create World flow did not register the generated world");
  results.push("Create World click, world readiness, and generated-world registration");

  let move = await request("/v1/move", { direction: "forward", ticks: 16 });
  if (move.positionChanged !== true) move = await request("/v1/move", { direction: "right", ticks: 16 });
  if (move.positionChanged !== true) move = await request("/v1/move", { direction: "jump", ticks: 4 });
  assert(move.accepted === true && move.before && move.after && move.positionChanged === true,
    "Movement inputs did not change the disposable world's player position");
  const look = await request("/v1/look", { yaw: 90, pitch: 15 });
  assert(look.ok === true && look.yaw === 90 && look.pitch === 15, "Look action did not set the requested view");
  const interaction = await request("/v1/interact", { ticks: 1 });
  assert(interaction.accepted === true && interaction.status?.worldReady === true, "Interaction did not complete in a ready world");
  results.push("movement, look, and item-use actions");

  menu = await getMenu();
  assert(menu.screen === "none", `Expected no menu after in-world actions, got ${menu.screen}`);
  menu = await press(menu, "escape");
  assert(menu.screen === "PauseScreen", "Escape did not open the pause menu");
  menu = await press(menu, "escape");
  assert(menu.screen === "none", "Escape did not resume from the pause menu");

  const leftToTitle = await request("/v1/worlds/leave", {});
  assert(leftToTitle.returnedToTitle === true && leftToTitle.status?.screen === "TitleScreen", "Leave did not synchronously return to title");
  results.push("pause/resume and save-to-title flow");

  let worlds = await request("/v1/worlds");
  const createdSave = worlds.worlds.find((world) => world.id === testWorldId);
  assert(createdSave?.generatedByMcp === true, "Generated world was not present in the save registry after leaving");
  const cleanup = await request("/v1/worlds/cleanup-generated", { worldId: testWorldId });
  assert(cleanup.deleted === true, "Generated test world cleanup failed");
  worlds = await request("/v1/worlds");
  assert(!worlds.worlds.some((world) => world.id === testWorldId), "Generated test save remained after cleanup");
  testWorldId = null;
  results.push("generated-world cleanup");

  menu = await getMenu();
  const singleplayer = findControl(menu, (control) => control.label === "Singleplayer", "Singleplayer button for Enter test");
  for (let attempt = 0; attempt < 10 && !singleplayer.focused; attempt++) {
    menu = await press(menu, "tab");
    if (menu.controls.find((control) => control.label === "Singleplayer")?.focused) break;
  }
  const focusedSingleplayer = findControl(menu, (control) => control.label === "Singleplayer" && control.focused, "focused Singleplayer button");
  menu = await press(menu, "enter");
  assert(menu.screen === "SelectWorldScreen", "Enter did not activate the focused Singleplayer button");
  menu = await press(menu, "escape");
  assert(menu.screen === "TitleScreen", "Escape did not return from saved-world selection");
  results.push("Enter activation and final Escape navigation");

  console.log(JSON.stringify({ passed: true, checks: results, testedKeys: keyNames, cleanedTestWorld: true }, null, 2));
}

main().catch(async (error) => {
  if (createdWorldReady && testWorldId) {
    try {
      const status = await request("/v1/status");
      if (status.singleplayer === true) await request("/v1/worlds/leave", {});
      const current = await request("/v1/status");
      if (current.worldPresent === false && current.screen === "TitleScreen") {
        const worlds = await request("/v1/worlds");
        if (worlds.worlds.some((world) => world.id === testWorldId && world.generatedByMcp === true)) {
          await request("/v1/worlds/cleanup-generated", { worldId: testWorldId });
        }
      }
    } catch {
      // Preserve the primary smoke-test failure; no untracked save is deleted.
    }
  }
  console.error(`Client smoke test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
