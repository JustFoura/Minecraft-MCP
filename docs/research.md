# Version and integration research

Research snapshot: 2026-09-30. Minecraft and Fabric versions move quickly; verify the Fabric version selector again when updating this project.

## Fabric toolchain for 26.3

Minecraft Java 26.3 is supported by Fabric. The version set used by this project is Minecraft 26.3, Fabric Loader 0.19.5, Fabric API 0.161.0+26.3, Java 25, Gradle 9.7.1, and Loom `1.18-SNAPSHOT` (resolved to 1.18.2 by the build in this workspace). The Java compilation and packaged client mod were verified with this set.

Minecraft 26.1 and later use unobfuscated names. The source uses Mojang's official names; Yarn mappings and the older intermediary-to-named remap workflow are not needed for this target. Accordingly, this build exposes `jar` and has no Loom `remapJar` task.

Fabric's 26.3 announcement recorded Loom 1.17 and Gradle 9.6.0 as the recommended versions at publication, and Loader 0.19.5 as the current stable loader. The workspace's generated template resolved newer Loom/Gradle project values and the current build succeeds; use the [Fabric version selector](https://fabricmc.net/develop/) before pin changes rather than treating these values as permanent.

## Minecraft mod development components

There is no separate Minecraft Java mod SDK required here. The project uses:

- **Fabric Loader** to load the mod and provide mod lifecycle/runtime services.
- **Fabric API** for client lifecycle and screen events.
- **Fabric Loom** with Gradle to acquire Minecraft artifacts, configure development launches, and package the mod.
- **Java 25** as the compilation/runtime baseline in the current project metadata.

The mod is client-side for the debug controls. It puts a small authenticated HTTP bridge inside the local game process; the MCP protocol server runs as a separate Node.js stdio process.

## Codex and MCP integration

Codex supports local MCP servers over stdio. This project uses the official TypeScript MCP SDK package `@modelcontextprotocol/sdk` for tool discovery and stdio transport. The MCP adapter translates typed tools to a per-project loopback HTTP bridge; the Fabric mod authenticates those requests with a random local bearer token. Minecraft slash commands are a separate bounded tool restricted to MCP-generated local single-player worlds; shell and Gradle command execution are not exposed.

The adapter is registered in the current user's Codex configuration under `minecraft-debug`, using an absolute Node entrypoint and `MINECRAFT_MCP_TOKEN_FILE`. Codex's official MCP docs describe `codex mcp add`, `codex mcp list`, stdio command/args/env fields, and `/mcp` for inspecting active server connections. A Codex reload is needed after adding a server for the current session to refresh its tool catalog.

## Primary references

- [Fabric: Minecraft 26.3 announcement](https://fabricmc.net/2026/09/15/263.html)
- [Fabric development version selector](https://fabricmc.net/develop/)
- [Fabric Loader documentation](https://docs.fabricmc.net/develop/loader/)
- [Fabric Loom documentation](https://docs.fabricmc.net/develop/loom/)
- [Fabric CLI documentation](https://fabricmc.net/develop/cli/)
- [OpenAI Docs — Codex MCP](https://developers.openai.com/codex/mcp)
- [OpenAI Docs — build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
