package minecraftmcp.client;

import net.fabricmc.api.ClientModInitializer;
import minecraftmcp.client.bridge.DebugBridge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class MinecraftMCPClient implements ClientModInitializer {
	private static final Logger LOGGER = LoggerFactory.getLogger("minecraft-mcp");

	@Override
	public void onInitializeClient() {
		try {
			DebugBridge.trackScreens();
			DebugBridge.start();
		} catch (Exception exception) {
			LOGGER.error("Could not start the local Minecraft MCP debug bridge", exception);
		}
	}
}
