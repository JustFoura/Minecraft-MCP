# Minecraft MCP Debug Harness

A local Fabric 26.3 development client and stdio MCP adapter. Codex can build and launch this repository's Minecraft client with the Minecraft-MCP Fabric mod already loaded, navigate the client UI, work in disposable worlds, inspect performance, and collect bounded logs and crash reports.

The implementation is early-stage. See [docs/architecture.md](docs/architecture.md) for the control contract and current limitations.

## What Codex can do

- Start the isolated development client with `launch_game`, check startup and bridge readiness, and stop it with `stop_game`.
- Inspect recent Gradle/Minecraft logs and the latest crash report. Returned text is bounded and redacts local paths, UUIDs, usernames, and token-shaped strings.
- Inspect current Minecraft menus and use revision-bound controls, text fields, and navigation keys. `open_create_world_menu` opens the real vanilla Create World screen; Codex can fill it and submit it through the UI.
- Read client FPS/frame time, JVM heap use, Minecraft/Loader versions, loaded mod versions, and measured integrated-server MSPT/TPS where available.
- Inspect, create, and leave single-player worlds; briefly move, look, and use the held item; capture screenshots.
- Load or edit an existing local save only through an allowlisted disposable copy. `cleanup_generated_world` deletes only exact test worlds and snapshots recorded as created by this mod.

The game controls use a fixed Gradle `runClient` task from this repository. They do not accept arbitrary commands, tasks, or paths. The UI tools refuse destructive controls and refuse to play or edit an original save from the saved-world menu. Use `edit_world_snapshot` to edit a copy.

## Toolchain

Install JDK 25 and Node.js 22 or newer. The generated project targets Minecraft 26.3, Fabric Loader 0.19.5, Fabric API 0.161.0+26.3, Java 25, Fabric Loom `1.18-SNAPSHOT` (resolved as 1.18.2 in the current build), and Gradle 9.7.1. Minecraft 26.1+ is unobfuscated, so the project uses Mojang's official names and has no Yarn mappings dependency. Loom does not create a `remapJar` task for this target; `./gradlew jar` produces the mod JAR directly.

## Build and connect Codex

Build the mod and compile the MCP adapter:

```sh
./gradlew build
cd mcp-server
npm ci
npm run build
```

Register the compiled stdio adapter once from the repository root:

```sh
codex mcp add minecraft-debug -- node /absolute/path/to/Minecraft-MCP/mcp-server/dist/index.js
```

Then restart or reload Codex and use `/mcp` to confirm `minecraft-debug` is connected. Codex starts the Node adapter as its MCP subprocess; **do not run `npm start` as a second server**. The adapter starts Minecraft only when Codex calls `launch_game`.

The first launch may need to download Gradle/Minecraft dependencies and can take several minutes. `launch_game` returns after accepting the request; poll `get_game_process_status` until `bridgeReady` is true. The client uses this project's isolated `run/` game directory, and the Fabric mod creates a local bearer token there on first launch.

To check the local bridge without changing game state:

```sh
cd mcp-server
npm run smoke
```

The smoke check verifies bridge health, unauthenticated-request rejection, and the authenticated status shape. It requires a running client.

If using a separately launched Minecraft profile instead of `launch_game`, set `MINECRAFT_MCP_TOKEN_FILE` to that profile's token file in the Codex server environment. Process management and crash-log collection currently target only this repository's `run/` development client.

## Working with worlds

Use `get_menu_state` and the menu tools to inspect and navigate the title, Create World, and Edit World flows. The pause screen is inspectable, then use Escape to resume or `leave_test_world` to save and return to title. `open_create_world_menu` opens the vanilla creation form directly; worlds created from that screen are tracked for later cleanup. The `create_test_world` tool remains available as a deterministic shortcut.

`list_worlds` lists saves in the isolated `run/` profile by exact folder ID. To test a world stored in another game profile, first copy it into this project's `run/saves/`, then add its exact folder ID to `run/config/minecraft-mcp/world-allowlist.txt`. `load_world_snapshot` opens a disposable copy; `edit_world_snapshot` opens a copy in Minecraft's Edit World menu. The source save is not opened or modified by these tools. Use `open_generated_world` to play a generated snapshot after editing, and `cleanup_generated_world` after returning to a menu to remove a tracked test world or snapshot.

For in-world actions, call `get_game_status` first and wait for `worldReady: true`. Movement lasts at most 40 ticks; item use lasts at most 20 ticks. `leave_test_world` saves and returns to the title screen. Screenshots are saved locally under the development profile, with a bounded retention of ten images.

## Safety and limitations

Use the isolated development profile and disposable worlds for debugging. The bridge binds only to `127.0.0.1`, requires a random bearer token for control endpoints, and schedules Minecraft state access on the client thread. A source world must be allowlisted before snapshot or edit-copy operations. Generated copies remain in `run/saves/` until cleaned up.

The current performance reading covers client FPS/frame time, JVM heap, and in-process integrated-server timing. It cannot report authoritative server TPS for a remote server. GameTests, target-project profiles, richer crash correlation, and automatic recovery from hangs remain planned work.
