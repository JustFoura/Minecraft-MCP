package minecraftmcp.client.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.mojang.logging.LogUtils;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.slf4j.Logger;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.worldselection.CreateWorldScreen;
import net.minecraft.client.gui.screens.worldselection.EditWorldScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.gui.screens.worldselection.WorldOpenFlows;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.server.IntegratedServer;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelSummary;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.level.storage.LevelStorageSource;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.Locale;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;


/** Local-only HTTP control surface. MCP itself is provided by the companion stdio process. */
public final class DebugBridge {
	private static final Logger LOGGER = LogUtils.getLogger();
	private static final int PORT = configuredPort();
	private static final int MAX_BODY_BYTES = 8 * 1024;
	private static final int MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
	private static final long MAX_SNAPSHOT_BYTES = 1024L * 1024L * 1024L;
	private static final int MAX_SNAPSHOT_ENTRIES = 100_000;
	private static final ScheduledExecutorService CLIENT_DISPATCH_TIMEOUTS = Executors.newSingleThreadScheduledExecutor(task -> {
		Thread thread = new Thread(task, "minecraft-mcp-client-dispatch-timeouts");
		thread.setDaemon(true);
		return thread;
	});
	private static volatile HttpServer server;
	private static volatile Screen activeScreen;
	private static volatile String currentScreen = "unknown";
	private static volatile long screenRevision;
	private static volatile int movementTicksRemaining;
	private static KeyMapping activeMovementKey;
	private static String activeMovementDirection;
	private static int movementRequestedTicks;
	private static Map<String, Object> movementStart;
	private static CompletableFuture<Map<String, Object>> movementCompletion;
	private static volatile int interactionTicksRemaining;
	private static KeyMapping activeInteractionKey;
	private static int activeInteractionTicks;
	private static CompletableFuture<Map<String, Object>> interactionCompletion;
	private static Boolean pauseOnLostFocusBeforeAutomation;
	private static String token;
	private static long serverTickStartedAt;
	private static long serverTickPreviousStartAt;
	private static long serverTickWindowTotalNanos;
	private static long serverTickWindowIntervalsNanos;
	private static int serverTickWindowCount;
	private static volatile double recentIntegratedServerMspt = -1.0;
	private static volatile double recentIntegratedServerTps = -1.0;
	private static volatile long createWorldMenuPendingUntil;

	private DebugBridge() {}

	private static int configuredPort() {
		String configured = System.getProperty("minecraft-mcp.port", "8765");
		try {
			int port = Integer.parseInt(configured);
			if (port < 1024 || port > 65535) throw new NumberFormatException("port out of range");
			return port;
		} catch (NumberFormatException exception) {
			throw new ExceptionInInitializerError("minecraft-mcp.port must be an integer from 1024 to 65535");
		}
	}

	public static void trackScreens() {
		net.fabricmc.fabric.api.client.screen.v1.ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
			if (activeMovementKey != null) {
				activeMovementKey.setDown(false);
				activeMovementKey = null;
				movementTicksRemaining = 0;
			}
			if (activeInteractionKey != null) {
				activeInteractionKey.setDown(false);
				activeInteractionKey = null;
				interactionTicksRemaining = 0;
			}
			activeScreen = screen;
			currentScreen = screen.getClass().getSimpleName();
			if (screen instanceof TitleScreen || screen instanceof SelectWorldScreen) {
				createWorldMenuPendingUntil = 0L;
				if (client.player == null && client.level == null) restorePauseOnLostFocus(client);
			}
			screenRevision++;
			ScreenEvents.remove(screen).register(removed -> {
				if (activeScreen == removed) {
					activeScreen = null;
					currentScreen = "none";
					screenRevision++;
				}
			});
		});
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			if (activeMovementKey != null && (client.player == null || !"none".equals(currentScreen) || --movementTicksRemaining <= 0)) {
				finishMovement(client);
			}
			if (activeInteractionKey != null && (client.player == null || !"none".equals(currentScreen) || --interactionTicksRemaining <= 0)) {
				finishInteraction(client);
			}
		});
		ServerTickEvents.START_SERVER_TICK.register(server -> {
			long now = System.nanoTime();
			if (serverTickPreviousStartAt > 0L) serverTickWindowIntervalsNanos += now - serverTickPreviousStartAt;
			serverTickStartedAt = now;
			serverTickPreviousStartAt = now;
			if (server instanceof IntegratedServer && System.currentTimeMillis() < createWorldMenuPendingUntil) {
				String worldId = currentSingleplayerWorldId(Minecraft.getInstance());
				if (!worldId.isEmpty()) {
					try {
						registerGeneratedWorldId(worldId);
						createWorldMenuPendingUntil = 0L;
					} catch (IOException exception) {
						LOGGER.error("Could not register a world created through the vanilla Create World menu", exception);
					}
				}
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			long elapsed = Math.max(0L, System.nanoTime() - serverTickStartedAt);
			serverTickWindowTotalNanos += elapsed;
			serverTickWindowCount++;
			if (serverTickWindowCount >= 20) {
				double averageMspt = serverTickWindowTotalNanos / (double) serverTickWindowCount / 1_000_000.0;
				recentIntegratedServerMspt = averageMspt;
				recentIntegratedServerTps = serverTickWindowIntervalsNanos <= 0L ? 0.0
					: Math.min(20.0, (serverTickWindowCount - 1) / (serverTickWindowIntervalsNanos / 1_000_000_000.0));
				serverTickWindowTotalNanos = 0L;
				serverTickWindowIntervalsNanos = 0L;
				serverTickWindowCount = 0;
				serverTickPreviousStartAt = 0L;
			}
		});
	}

	private static void finishMovement(Minecraft client) {
		if (activeMovementKey == null) return;
		activeMovementKey.setDown(false);
		activeMovementKey = null;
		movementTicksRemaining = 0;
		CompletableFuture<Map<String, Object>> completion = movementCompletion;
		movementCompletion = null;
		Map<String, Object> end = playerPosition(client);
		if (completion != null) completion.complete(Map.of("accepted", true, "direction", activeMovementDirection,
			"requestedTicks", movementRequestedTicks, "before", movementStart == null ? Map.of() : movementStart,
			"after", end, "positionChanged", !end.equals(movementStart == null ? Map.of() : movementStart),
			"status", statusSnapshot(client)));
		activeMovementDirection = null;
		movementRequestedTicks = 0;
		movementStart = null;
	}

	private static void finishInteraction(Minecraft client) {
		if (activeInteractionKey == null) return;
		activeInteractionKey.setDown(false);
		activeInteractionKey = null;
		interactionTicksRemaining = 0;
		CompletableFuture<Map<String, Object>> completion = interactionCompletion;
		interactionCompletion = null;
		if (completion != null) completion.complete(Map.of("accepted", true, "ticks", activeInteractionTicks,
			"status", statusSnapshot(client)));
		activeInteractionTicks = 0;
	}

	private static Map<String, Object> playerPosition(Minecraft client) {
		var player = client.player;
		return player == null ? Map.of() : Map.of("x", player.getX(), "y", player.getY(), "z", player.getZ());
	}

	private static void disablePauseOnLostFocusForAutomation(Minecraft client) {
		if (pauseOnLostFocusBeforeAutomation == null) {
			pauseOnLostFocusBeforeAutomation = client.options.pauseOnLostFocus;
		}
		client.options.pauseOnLostFocus = false;
	}

	private static void restorePauseOnLostFocus(Minecraft client) {
		if (pauseOnLostFocusBeforeAutomation == null) return;
		client.options.pauseOnLostFocus = pauseOnLostFocusBeforeAutomation;
		pauseOnLostFocusBeforeAutomation = null;
	}

	public static synchronized void start() throws IOException {
		if (server != null) return;
		token = loadOrCreateToken();
		HttpServer http = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 0);
		http.createContext("/health", exchange -> respond(exchange, 200, Map.of("ok", true, "service", "minecraft-mcp")));
		http.createContext("/v1/status", DebugBridge::status);
		http.createContext("/v1/performance", DebugBridge::performance);
		http.createContext("/v1/ui", DebugBridge::uiState);
		http.createContext("/v1/ui/open-create-world", DebugBridge::openCreateWorldMenu);
		http.createContext("/v1/ui/click", DebugBridge::clickUiControl);
		http.createContext("/v1/ui/text", DebugBridge::setUiText);
		http.createContext("/v1/ui/key", DebugBridge::pressUiKey);
		http.createContext("/v1/look", DebugBridge::look);
		http.createContext("/v1/move", DebugBridge::move);
		http.createContext("/v1/interact", DebugBridge::interact);
		http.createContext("/v1/command", DebugBridge::runCommand);
		http.createContext("/v1/screenshot", DebugBridge::screenshot);
		http.createContext("/v1/worlds", DebugBridge::worlds);
		http.createContext("/v1/worlds/create-test", DebugBridge::createTestWorld);
		http.createContext("/v1/worlds/leave", DebugBridge::leaveWorld);
		http.createContext("/v1/worlds/load-snapshot", DebugBridge::loadWorldSnapshot);
		http.createContext("/v1/worlds/edit-snapshot", DebugBridge::editWorldSnapshot);
		http.createContext("/v1/worlds/open-generated", DebugBridge::openGeneratedWorld);
		http.createContext("/v1/worlds/cleanup-generated", DebugBridge::cleanupGeneratedWorld);
		http.setExecutor(new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS,
			new ArrayBlockingQueue<>(32), task -> {
				Thread thread = new Thread(task, "minecraft-mcp-http");
				thread.setDaemon(true);
				return thread;
			}, new ThreadPoolExecutor.AbortPolicy()));
		http.start();
		server = http;
		Runtime.getRuntime().addShutdownHook(new Thread(() -> http.stop(0), "minecraft-mcp-stop"));
	}

	private static void status(HttpExchange exchange) throws IOException {
		if (!"/v1/status".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"GET".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use GET"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> {
			return statusSnapshot(Minecraft.getInstance());
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 503, Map.of("error", "Minecraft client did not answer the status request"));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static Map<String, Object> statusSnapshot(Minecraft client) {
		var player = client.player;
		var level = client.level;
		String worldId = currentSingleplayerWorldId(client);
		return Map.ofEntries(
			Map.entry("connected", player != null && level != null),
			Map.entry("worldReady", player != null && level != null && "none".equals(currentScreen)),
			Map.entry("singleplayer", client.hasSingleplayerServer()),
			Map.entry("playerPresent", player != null),
			Map.entry("worldPresent", level != null),
			Map.entry("windowActive", client.isWindowActive()),
			Map.entry("screen", currentScreen),
			Map.entry("worldId", worldId),
			Map.entry("generatedByMcp", !worldId.isEmpty() && isGeneratedWorldId(worldId)),
			Map.entry("gameMode", client.gameMode == null ? "none" : client.gameMode.getPlayerMode().getName()),
			Map.entry("player", player == null ? Map.of() : Map.of(
				"x", player.getX(), "y", player.getY(), "z", player.getZ(),
				"yaw", player.getYRot(), "pitch", player.getXRot()
			))
		);
	}

	private static String currentSingleplayerWorldId(Minecraft client) {
		IntegratedServer server = client.getSingleplayerServer();
		if (server == null) return "";
		Path saves = client.getLevelSource().getBaseDir().toAbsolutePath().normalize();
		Path worldRoot = server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
		if (!worldRoot.startsWith(saves)) return "";
		Path relative = saves.relativize(worldRoot).normalize();
		if (relative.getNameCount() != 1) return "";
		String worldId = relative.getFileName().toString();
		return isSafeWorldId(worldId) ? worldId : "";
	}

	private static void performance(HttpExchange exchange) throws IOException {
		if (!"/v1/performance".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"GET".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use GET"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			Runtime runtime = Runtime.getRuntime();
			long usedHeap = runtime.totalMemory() - runtime.freeMemory();
			var allMods = FabricLoader.getInstance().getAllMods();
			List<Map<String, String>> mods = allMods.stream()
				.limit(200)
				.map(container -> Map.of(
					"id", container.getMetadata().getId(),
					"version", container.getMetadata().getVersion().getFriendlyString()))
				.toList();
			String loaderVersion = FabricLoader.getInstance().getModContainer("fabricloader")
				.map(container -> container.getMetadata().getVersion().getFriendlyString()).orElse("unknown");
			Map<String, Object> integratedServer;
			IntegratedServer localServer = client.getSingleplayerServer();
			if (localServer == null || !localServer.isRunning()) {
				integratedServer = Map.of("running", false, "msptAvailable", false, "tpsAvailable", false);
			} else if (recentIntegratedServerMspt < 0.0) {
				integratedServer = Map.of("running", true, "msptAvailable", false, "tpsAvailable", false,
					"sampleWindowTicks", 20);
			} else {
				integratedServer = Map.of("running", true, "msptAvailable", true,
					"averageMspt", recentIntegratedServerMspt, "observedTps", recentIntegratedServerTps,
					"sampleWindowTicks", 20);
			}
			String minecraftVersion = FabricLoader.getInstance().getModContainer("minecraft")
				.map(container -> container.getMetadata().getVersion().getFriendlyString())
				.orElse("unknown");
			return Map.<String, Object>ofEntries(
				Map.entry("minecraftVersion", minecraftVersion),
				Map.entry("fabricLoaderVersion", loaderVersion),
				Map.entry("fps", client.getFps()),
				Map.entry("frameTimeMs", client.getFrameTimeNs() / 1_000_000.0),
				Map.entry("heapUsedBytes", usedHeap),
				Map.entry("heapAllocatedBytes", runtime.totalMemory()),
				Map.entry("heapMaxBytes", runtime.maxMemory()),
				Map.entry("loadedModCount", allMods.size()),
				Map.entry("loadedModsTruncated", allMods.size() > mods.size()),
				Map.entry("integratedServer", integratedServer),
				Map.entry("loadedMods", mods)
			);
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 503, Map.of("error", "Minecraft client did not answer the performance request"));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static List<AbstractWidget> visibleWidgets(Screen screen) {
		List<AbstractWidget> widgets = new ArrayList<>();
		for (var child : screen.children()) {
			if (child instanceof AbstractWidget widget && widget.visible) widgets.add(widget);
		}
		return widgets;
	}

	private static Map<String, Object> uiState(Screen screen) {
		List<Map<String, Object>> controls = new ArrayList<>();
		List<AbstractWidget> widgets = visibleWidgets(screen);
		for (int index = 0; index < widgets.size() && index < 128; index++) {
			AbstractWidget widget = widgets.get(index);
			String label = widget.getMessage().getString();
			Map<String, Object> control = new java.util.LinkedHashMap<>();
			control.put("index", index);
			control.put("type", widget.getClass().getSimpleName());
			control.put("label", label.length() > 160 ? label.substring(0, 160) : label);
			control.put("active", widget.active);
			control.put("focused", widget.isFocused());
			control.put("x", widget.getX());
			control.put("y", widget.getY());
			control.put("width", widget.getWidth());
			control.put("height", widget.getHeight());
			if (widget instanceof EditBox editBox) {
				control.put("textLength", editBox.getValue().length());
				control.put("cursorPosition", editBox.getCursorPosition());
				control.put("selectionLength", editBox.getHighlighted().length());
			}
			controls.add(control);
		}
		return Map.of(
			"screenRevision", screenRevision,
			"screen", screen.getClass().getSimpleName(),
			"title", screen.getTitle().getString(),
			"width", screen.width,
			"height", screen.height,
			"controls", controls,
			"truncated", widgets.size() > 128
		);
	}

	private static void uiState(HttpExchange exchange) throws IOException {
		if (!"/v1/ui".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"GET".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use GET"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> activeScreen == null
			? Map.<String, Object>of("screenRevision", screenRevision, "screen", "none", "title", "", "controls", List.of(), "truncated", false)
			: uiState(activeScreen)
		).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 503, Map.of("error", "Minecraft client did not answer the menu-state request"));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static void openCreateWorldMenu(HttpExchange exchange) throws IOException {
		if (!"/v1/ui/open-create-world".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Leave the current world before opening Create World");
			CreateWorldScreen.openFresh(client, () -> client.setScreenAndShow(new SelectWorldScreen(new TitleScreen())));
			return Map.<String, Object>of("accepted", true, "screen", "CreateWorldScreen",
				"menu", currentUiState());
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static JsonObject readSmallJsonObject(HttpExchange exchange) throws IOException {
		byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
		if (body.length > MAX_BODY_BYTES) throw new IllegalArgumentException("Request body is too large");
		return JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static long readNonnegativeLong(JsonObject input, String property) {
		if (!input.has(property) || !input.get(property).isJsonPrimitive() || !input.getAsJsonPrimitive(property).isNumber()) {
			throw new IllegalArgumentException("Expected a nonnegative integer " + property);
		}
		double value = input.get(property).getAsDouble();
		if (!Double.isFinite(value) || value < 0 || value > Long.MAX_VALUE || value != Math.rint(value)) {
			throw new IllegalArgumentException("Expected a nonnegative integer " + property);
		}
		return (long) value;
	}

	private static int readBoundedInt(JsonObject input, String property, int minimum, int maximum) {
		long value = readNonnegativeLong(input, property);
		if (value < minimum || value > maximum) throw new IllegalArgumentException(property + " must be between " + minimum + " and " + maximum);
		return (int) value;
	}

	private static void clickUiControl(HttpExchange exchange) throws IOException {
		if (!"/v1/ui/click".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		long requestedRevision;
		int index;
		try {
			input = readSmallJsonObject(exchange);
			requestedRevision = readNonnegativeLong(input, "screenRevision");
			index = readBoundedInt(input, "index", 0, 127);
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected screenRevision and a control index from get_menu_state"));
			return;
		}
		callOnClientThread(() -> {
			Screen screen = activeScreen;
			if (screen == null || requestedRevision != screenRevision) throw new IllegalStateException("The menu changed; call get_menu_state again before clicking");
			List<AbstractWidget> widgets = visibleWidgets(screen);
			if (index >= widgets.size()) throw new IllegalArgumentException("Control index is no longer available");
			AbstractWidget widget = widgets.get(index);
			if (!widget.visible || !widget.active) throw new IllegalStateException("The selected menu control is hidden or disabled");
			String label = widget.getMessage().getString();
			if (isProtectedMenuAction(screen, label)) throw new IllegalStateException("This menu action could modify or delete an original save; use the allowlisted snapshot workflow instead");
			boolean startsVanillaWorldCreation = screen instanceof CreateWorldScreen
				&& label.toLowerCase(Locale.ROOT).contains("create");
			if (startsVanillaWorldCreation) {
				createWorldMenuPendingUntil = System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(3);
				disablePauseOnLostFocusForAutomation(Minecraft.getInstance());
			}
			String before = uiFingerprint(screen);
			long beforeRevision = screenRevision;
			MouseButtonEvent event = new MouseButtonEvent(widget.getX() + widget.getWidth() / 2.0,
				widget.getY() + widget.getHeight() / 2.0, new MouseButtonInfo(InputConstants.MOUSE_BUTTON_LEFT, 0));
			screen.afterMouseAction();
			boolean pressed = screen.mouseClicked(event, false);
			boolean released = pressed && screen.mouseReleased(event);
			Screen resultingScreen = activeScreen;
			String after = resultingScreen == null ? "none" : uiFingerprint(resultingScreen);
			boolean changed = screen != resultingScreen || !before.equals(after);
			if (!pressed || !released || (!changed && resultingScreen == screen)) {
				if (startsVanillaWorldCreation) {
					createWorldMenuPendingUntil = 0L;
					restorePauseOnLostFocus(Minecraft.getInstance());
				}
				throw new IllegalStateException("Minecraft did not activate the selected control; no UI change was observed");
			}
			if (screenRevision == beforeRevision) screenRevision++;
			return Map.<String, Object>of("accepted", true, "verified", true, "changed", true,
				"controlIndex", index, "label", label.length() > 160 ? label.substring(0, 160) : label,
				"screenRevision", screenRevision, "menu", currentUiState());
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static boolean isProtectedMenuAction(Screen screen, String label) {
		String normalized = label.toLowerCase(Locale.ROOT);
		if (screen instanceof net.minecraft.client.gui.screens.PauseScreen) return !normalized.equals("back to game");
		if (isEscapeOnlyScreen(screen)) return true;
		if (List.of("delete", "remove", "erase", "reset to defaults", "restore defaults", "open to lan", "local network",
			"share", "publish", "open folder", "browse", "import").stream().anyMatch(normalized::contains)) return true;
		if (List.of("multiplayer", "realms").stream().anyMatch(normalized::contains)) return true;
		return screen instanceof SelectWorldScreen
			&& List.of("create", "back", "cancel").stream().noneMatch(normalized::contains);
	}

	private static String uiFingerprint(Screen screen) {
		StringBuilder fingerprint = new StringBuilder(screen.getClass().getName()).append('|').append(screen.getTitle().getString());
		for (AbstractWidget widget : visibleWidgets(screen)) {
			fingerprint.append('|').append(widget.getClass().getName()).append(':')
				.append(widget.getMessage().getString()).append(':').append(widget.active).append(':').append(widget.isFocused());
			if (widget instanceof EditBox editBox) {
				fingerprint.append(':').append(editBox.getValue()).append(':').append(editBox.getCursorPosition())
					.append(':').append(editBox.getHighlighted());
			}
		}
		return fingerprint.toString();
	}

	private static Map<String, Object> currentUiState() {
		return activeScreen == null
			? Map.of("screenRevision", screenRevision, "screen", "none", "title", "", "controls", List.of(), "truncated", false)
			: uiState(activeScreen);
	}

	private static boolean isRemoteServerMenu(Screen screen) {
		String name = screen.getClass().getSimpleName().toLowerCase(Locale.ROOT);
		return name.contains("multiplayer") || name.contains("realms");
	}

	private static boolean isConfirmationScreen(Screen screen) {
		return screen.getClass().getSimpleName().toLowerCase(Locale.ROOT).contains("confirm");
	}

	private static boolean isEscapeOnlyScreen(Screen screen) {
		return isRemoteServerMenu(screen) || isConfirmationScreen(screen)
			|| screen.getClass().getSimpleName().equals("PauseScreen");
	}

	private static void setUiText(HttpExchange exchange) throws IOException {
		if (!"/v1/ui/text".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		long requestedRevision;
		int index;
		String value;
		try {
			input = readSmallJsonObject(exchange);
			requestedRevision = readNonnegativeLong(input, "screenRevision");
			index = readBoundedInt(input, "index", 0, 127);
			if (!input.has("value") || !input.get("value").isJsonPrimitive() || !input.getAsJsonPrimitive("value").isString()) {
				throw new IllegalArgumentException("Expected a text value");
			}
			value = input.get("value").getAsString();
			if (value.length() > 128 || value.chars().anyMatch(character -> Character.isISOControl(character))) {
				throw new IllegalArgumentException("Text must be at most 128 characters and contain no control characters");
			}
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected screenRevision, control index, and bounded text value"));
			return;
		}
		String requestedValue = value;
		callOnClientThread(() -> {
			Screen screen = activeScreen;
			if (screen == null || requestedRevision != screenRevision) throw new IllegalStateException("The menu changed; call get_menu_state again before editing text");
			List<AbstractWidget> widgets = visibleWidgets(screen);
			if (index >= widgets.size() || !(widgets.get(index) instanceof EditBox editBox)) throw new IllegalArgumentException("Selected control is not a visible text field");
			if (!editBox.active) throw new IllegalStateException("The selected text field is disabled");
			editBox.setValue(requestedValue);
			editBox.setCursorPosition(requestedValue.length());
			screenRevision++;
			return Map.<String, Object>of("accepted", true, "screen", screen.getClass().getSimpleName(), "controlIndex", index,
				"verified", editBox.getValue().equals(requestedValue), "screenRevision", screenRevision,
				"textLength", editBox.getValue().length(), "menu", uiState(screen));
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static void pressUiKey(HttpExchange exchange) throws IOException {
		if (!"/v1/ui/key".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		long requestedRevision;
		String key;
		try {
			input = readSmallJsonObject(exchange);
			requestedRevision = readNonnegativeLong(input, "screenRevision");
			if (!input.has("key") || !input.get("key").isJsonPrimitive() || !input.getAsJsonPrimitive("key").isString()) {
				throw new IllegalArgumentException("Expected an allowlisted menu key");
			}
			key = input.get("key").getAsString();
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected screenRevision and an allowlisted menu key"));
			return;
		}
		MenuKey menuKey = switch (key) {
			case "enter" -> new MenuKey(InputConstants.KEY_RETURN, InputConstants.KEYCODE_RETURN);
			case "escape" -> new MenuKey(InputConstants.KEY_ESCAPE, 27);
			case "tab" -> new MenuKey(InputConstants.KEY_TAB, InputConstants.KEYCODE_TAB);
			case "up" -> new MenuKey(InputConstants.KEY_UP, InputConstants.KEYCODE_UP);
			case "down" -> new MenuKey(InputConstants.KEY_DOWN, InputConstants.KEYCODE_DOWN);
			case "left" -> new MenuKey(InputConstants.KEY_LEFT, InputConstants.KEYCODE_LEFT);
			case "right" -> new MenuKey(InputConstants.KEY_RIGHT, InputConstants.KEYCODE_RIGHT);
			case "space" -> new MenuKey(InputConstants.KEY_SPACE, InputConstants.KEYCODE_SPACE);
			case "backspace" -> new MenuKey(InputConstants.KEY_BACKSPACE, InputConstants.KEYCODE_BACKSPACE);
			default -> null;
		};
		if (menuKey == null) {
			respond(exchange, 400, Map.of("error", "Unsupported menu key"));
			return;
		}
		String requestedKey = key;
		callOnClientThread(() -> {
			Screen screen = activeScreen;
			Minecraft client = Minecraft.getInstance();
			if (requestedRevision != screenRevision) throw new IllegalStateException("The menu changed; call get_menu_state again before pressing a key");
			if (screen == null && "escape".equals(requestedKey) && client.player != null && client.level != null) {
				client.pauseGame(true);
				return Map.<String, Object>of("accepted", true, "screen", "PauseScreen", "key", requestedKey,
					"screenRevision", screenRevision, "changed", true, "menu", currentUiState());
			}
			if (screen == null) throw new IllegalStateException("There is no active menu screen to receive that key");
			if (screen instanceof SelectWorldScreen && List.of("enter", "space").contains(requestedKey)) {
				throw new IllegalStateException("Activating a saved-world selection from the menu is disabled; use load_world_snapshot");
			}
			if (isEscapeOnlyScreen(screen) && !"escape".equals(requestedKey)) {
				throw new IllegalStateException("This screen accepts Escape only through the MCP controls");
			}
			boolean activatesFocusedControl = "enter".equals(requestedKey) || "space".equals(requestedKey);
			if (activatesFocusedControl && visibleWidgets(screen).stream()
				.filter(widget -> !(widget instanceof EditBox))
				.filter(AbstractWidget::isFocused)
				.anyMatch(widget -> isProtectedMenuAction(screen, widget.getMessage().getString()))) {
				throw new IllegalStateException("The focused control is outside the supported safe menu actions");
			}
			String title = screen.getTitle().getString().toLowerCase(Locale.ROOT);
			if ("enter".equals(requestedKey) && List.of("delete", "remove", "reset").stream().anyMatch(title::contains)) {
				throw new IllegalStateException("Confirmation screens for destructive actions are disabled");
			}
			boolean startsVanillaWorldCreation = screen instanceof CreateWorldScreen && "enter".equals(requestedKey);
			if (startsVanillaWorldCreation) {
				createWorldMenuPendingUntil = System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(3);
				disablePauseOnLostFocusForAutomation(client);
			}
			String before = uiFingerprint(screen);
			long beforeRevision = screenRevision;
			KeyEvent event = new KeyEvent(menuKey.scanCode(), menuKey.keyCode(), 0);
			screen.afterKeyboardAction();
			boolean handled = screen.keyPressed(event);
			boolean released = screen.keyReleased(event);
			Screen resultingScreen = activeScreen;
			String after = resultingScreen == null ? "none" : uiFingerprint(resultingScreen);
			boolean changed = resultingScreen != screen || !before.equals(after);
			if (!handled && !released && !changed) {
				if (startsVanillaWorldCreation) {
					createWorldMenuPendingUntil = 0L;
					restorePauseOnLostFocus(client);
				}
				throw new IllegalStateException("The current screen did not accept that key");
			}
			if (screenRevision == beforeRevision) screenRevision++;
			return Map.<String, Object>of("accepted", true, "handled", handled || released, "changed", changed,
				"key", requestedKey, "screenRevision", screenRevision, "menu", currentUiState());
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private record MenuKey(int scanCode, int keyCode) {}

	private static String safeMessage(Throwable throwable) {
		return rootMessage(throwable);
	}

	private static void look(HttpExchange exchange) throws IOException {
		if (!"/v1/look".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		try {
			byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
			if (body.length > MAX_BODY_BYTES) {
				respond(exchange, 413, Map.of("error", "Request body is too large"));
				return;
			}
			input = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected a JSON object with numeric yaw and pitch"));
			return;
		}
		if (!input.has("yaw") || !input.has("pitch") || !input.get("yaw").isJsonPrimitive() || !input.get("pitch").isJsonPrimitive()
			|| !input.getAsJsonPrimitive("yaw").isNumber() || !input.getAsJsonPrimitive("pitch").isNumber()) {
			respond(exchange, 400, Map.of("error", "Both yaw and pitch are required"));
			return;
		}
		float yaw;
		float pitch;
		try {
			yaw = input.get("yaw").getAsFloat();
			pitch = input.get("pitch").getAsFloat();
		} catch (RuntimeException exception) {
			respond(exchange, 400, Map.of("error", "Yaw and pitch must be numbers"));
			return;
		}
		if (!Float.isFinite(yaw) || !Float.isFinite(pitch) || Math.abs(yaw) > 36000 || pitch < -90 || pitch > 90) {
			respond(exchange, 400, Map.of("error", "Yaw must be within +/-36000 and pitch within -90..90"));
			return;
		}
		callOnClientThread(() -> {
			var player = Minecraft.getInstance().player;
			if (player == null) throw new IllegalStateException("No player is currently in a world");
			player.setYRot(yaw);
			player.setXRot(pitch);
			return Map.of("ok", true, "yaw", player.getYRot(), "pitch", player.getXRot());
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static void screenshot(HttpExchange exchange) throws IOException {
		if (!"/v1/screenshot".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"GET".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use GET"));
			return;
		}
		if (!authorized(exchange)) return;
		CompletableFuture<byte[]> capture = new CompletableFuture<>();
		AtomicReference<Path> artifact = new AtomicReference<>();
		Minecraft client = Minecraft.getInstance();
		client.execute(() -> {
			try {
				Screenshot.takeScreenshot(client.gameRenderer.mainRenderTarget(), image -> {
					try {
						Path directory = FabricLoader.getInstance().getConfigDir().resolve("minecraft-mcp").resolve("screenshots");
						Files.createDirectories(directory);
						Path path = directory.resolve("capture-" + UUID.randomUUID() + ".png");
						artifact.set(path);
						image.writeToFile(path);
						if (Files.size(path) > MAX_SCREENSHOT_BYTES) throw new IOException("Screenshot exceeds the 6 MiB response limit");
						byte[] bytes = Files.readAllBytes(path);
						pruneScreenshots(directory, path);
						if (!capture.complete(bytes)) Files.deleteIfExists(path);
					} catch (Throwable throwable) {
						capture.completeExceptionally(throwable);
					} finally {
						image.close();
					}
				});
			} catch (Throwable throwable) {
				capture.completeExceptionally(throwable);
			}
		});
		capture.orTimeout(10, TimeUnit.SECONDS).whenComplete((bytes, error) -> {
			if (error != null) {
				Path failedArtifact = artifact.get();
				if (failedArtifact != null) try { Files.deleteIfExists(failedArtifact); } catch (IOException ignored) { }
				respondQuietly(exchange, 503, Map.of("error", rootMessage(error)));
			}
			else respondPngQuietly(exchange, bytes);
		});
	}

	private static synchronized void pruneScreenshots(Path directory, Path newest) throws IOException {
		try (var files = Files.list(directory)) {
			List<Path> screenshots = files.filter(path -> path.getFileName().toString().startsWith("capture-")
				&& path.getFileName().toString().endsWith(".png"))
				.sorted((left, right) -> {
					try { return Files.getLastModifiedTime(right).compareTo(Files.getLastModifiedTime(left)); }
					catch (IOException exception) { return 0; }
				}).toList();
			int retained = 1;
			for (Path screenshot : screenshots) {
				if (screenshot.equals(newest)) continue;
				if (retained < 10) {
					retained++;
					continue;
				}
				Files.deleteIfExists(screenshot);
			}
		}
	}

	private static void move(HttpExchange exchange) throws IOException {
		if (!"/v1/move".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		String direction;
		int ticks;
		try {
			byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
			if (body.length > MAX_BODY_BYTES) {
				respond(exchange, 413, Map.of("error", "Request body is too large"));
				return;
			}
			JsonObject input = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
			if (!input.has("direction") || !input.get("direction").isJsonPrimitive() || !input.getAsJsonPrimitive("direction").isString()
				|| !input.has("ticks") || !input.get("ticks").isJsonPrimitive() || !input.getAsJsonPrimitive("ticks").isNumber()) {
				respond(exchange, 400, Map.of("error", "direction and integer ticks are required"));
				return;
			}
			direction = input.get("direction").getAsString();
			ticks = input.get("ticks").getAsInt();
		} catch (JsonSyntaxException | IllegalStateException | NumberFormatException exception) {
			respond(exchange, 400, Map.of("error", "Expected JSON with direction and integer ticks"));
			return;
		}
		if (!List.of("forward", "backward", "left", "right", "jump").contains(direction) || ticks < 1 || ticks > 40) {
			respond(exchange, 400, Map.of("error", "direction must be forward/backward/left/right/jump and ticks must be 1..40"));
			return;
		}
		CompletableFuture<Map<String, Object>> completion = new CompletableFuture<>();
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player == null || client.level == null) throw new IllegalStateException("A world must be loaded before moving");
			if (!"none".equals(currentScreen)) throw new IllegalStateException("Close the current screen before moving");
			if (activeMovementKey != null) throw new IllegalStateException("A movement action is already in progress");
			if (anyMovementKeyDown(client)) throw new IllegalStateException("A movement key is already held; release controls before automated movement");
			KeyMapping key = switch (direction) {
				case "forward" -> client.options.keyUp;
				case "backward" -> client.options.keyDown;
				case "left" -> client.options.keyLeft;
				case "right" -> client.options.keyRight;
				case "jump" -> client.options.keyJump;
				default -> throw new IllegalArgumentException("Unsupported movement direction");
			};
			movementStart = playerPosition(client);
			movementRequestedTicks = ticks;
			activeMovementDirection = direction;
			movementCompletion = completion;
			activeMovementKey = key;
			movementTicksRemaining = ticks;
			key.setDown(true);
			return completion;
		}).thenCompose(future -> future).orTimeout(10, TimeUnit.SECONDS).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static boolean anyMovementKeyDown(Minecraft client) {
		return client.options.keyUp.isDown() || client.options.keyDown.isDown() || client.options.keyLeft.isDown()
			|| client.options.keyRight.isDown() || client.options.keyJump.isDown() || client.options.keyShift.isDown()
			|| client.options.keySprint.isDown();
	}

	private static void interact(HttpExchange exchange) throws IOException {
		if (!"/v1/interact".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		int ticks;
		try {
			JsonObject input = readSmallJsonObject(exchange);
			ticks = readBoundedInt(input, "ticks", 1, 20);
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected an integer ticks value from 1 to 20"));
			return;
		}
		int requestedTicks = ticks;
		CompletableFuture<Map<String, Object>> completion = new CompletableFuture<>();
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player == null || client.level == null) throw new IllegalStateException("A world must be loaded before interacting");
			if (!"none".equals(currentScreen)) throw new IllegalStateException("Close the current screen before interacting");
			if (activeInteractionKey != null) throw new IllegalStateException("An interaction action is already in progress");
			if (client.options.keyUse.isDown()) throw new IllegalStateException("The use key is already held; release controls before automated interaction");
			activeInteractionKey = client.options.keyUse;
			activeInteractionTicks = requestedTicks;
			interactionCompletion = completion;
			interactionTicksRemaining = requestedTicks;
			activeInteractionKey.setDown(true);
			return completion;
		}).thenCompose(future -> future).orTimeout(10, TimeUnit.SECONDS).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static void runCommand(HttpExchange exchange) throws IOException {
		if (!"/v1/command".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		String command;
		try {
			JsonObject input = readSmallJsonObject(exchange);
			if (!input.has("command") || !input.get("command").isJsonPrimitive() || !input.getAsJsonPrimitive("command").isString()) {
				throw new IllegalArgumentException("Expected a slash command");
			}
			String raw = input.get("command").getAsString();
			if (raw.length() > 256 || raw.chars().anyMatch(Character::isISOControl)) {
				throw new IllegalArgumentException("Command must be at most 256 characters with no control characters");
			}
			command = raw.strip();
			if (command.startsWith("/")) command = command.substring(1).stripLeading();
			if (command.isEmpty() || command.startsWith("/") || command.length() > 256) {
				throw new IllegalArgumentException("Expected one non-empty Minecraft command, with at most one leading slash");
			}
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected a Minecraft slash command of at most 256 characters"));
			return;
		}
		String requestedCommand = command;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (!client.hasSingleplayerServer() || client.player == null || client.level == null) {
				throw new IllegalStateException("Commands are available only in a local single-player world");
			}
			if (!"none".equals(currentScreen)) throw new IllegalStateException("Close the current screen before sending a command");
			String worldId = currentSingleplayerWorldId(client);
			if (worldId.isEmpty() || !isGeneratedWorldId(worldId)) {
				throw new IllegalStateException("Commands are limited to MCP-generated test worlds and disposable snapshots");
			}
			client.player.connection.sendCommand(requestedCommand);
			return Map.<String, Object>of("accepted", true, "command", "/" + requestedCommand,
				"worldId", worldId, "status", statusSnapshot(client));
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 200, result);
		});
	}

	private static void worlds(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"GET".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use GET"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before listing saved worlds");
			var source = client.getLevelSource();
			return source.loadLevelSummaries(source.findLevelCandidates());
		}).thenCompose(future -> future).whenComplete((summaries, error) -> {
			if (error != null) {
				respondQuietly(exchange, 503, Map.of("error", "Could not list local worlds", "detail", rootMessage(error)));
				return;
			}
			List<Map<String, Object>> worlds = summaries.stream().map(DebugBridge::worldSummary).toList();
			respondQuietly(exchange, 200, Map.of("worlds", worlds, "loadPolicy", "allowlisted snapshots only"));
		});
	}

	private static void createTestWorld(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/create-test".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		Long requestedSeed = null;
		try {
			byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
			if (body.length > MAX_BODY_BYTES) {
				respond(exchange, 413, Map.of("error", "Request body is too large"));
				return;
			}
			String bodyText = new String(body, StandardCharsets.UTF_8).trim();
			if (!bodyText.isEmpty()) {
				JsonObject input = JsonParser.parseString(bodyText).getAsJsonObject();
				if (input.has("seed")) {
					if (!input.get("seed").isJsonPrimitive() || !input.getAsJsonPrimitive("seed").isNumber()) {
						respond(exchange, 400, Map.of("error", "seed must be an integer"));
						return;
					}
					requestedSeed = input.get("seed").getAsLong();
				}
			}
		} catch (JsonSyntaxException | IllegalStateException | NumberFormatException exception) {
			respond(exchange, 400, Map.of("error", "Expected an empty JSON object or an integer seed"));
			return;
		}
		final Long seed = requestedSeed;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before creating a test world");
			String worldId = "mcp_test_" + UUID.randomUUID().toString().replace("-", "");
			if (!client.getLevelSource().isNewLevelIdAcceptable(worldId)) throw new IllegalStateException("Could not reserve a new test-world ID");
			registerGeneratedWorldId(worldId);
			LevelSettings settings = new LevelSettings("Minecraft MCP Test", GameType.SURVIVAL,
				LevelSettings.DifficultySettings.DEFAULT, true, WorldDataConfiguration.DEFAULT);
			WorldOptions options = seed == null ? WorldOptions.defaultWithRandomSeed() : new WorldOptions(seed, true, false);
			disablePauseOnLostFocusForAutomation(client);
			client.createWorldOpenFlows().createFreshLevel(worldId, settings, options, WorldPresets::createNormalWorldDimensions, null);
			return Map.<String, Object>of("accepted", true, "worldId", worldId,
				"seed", options.seed(), "message", "World creation started.");
		}, 180).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static void leaveWorld(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/leave".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (!client.hasSingleplayerServer()) throw new IllegalStateException("No local single-player world is open");
			try {
				client.disconnect(new TitleScreen(), false);
			} finally {
				restorePauseOnLostFocus(client);
			}
			return Map.<String, Object>of("accepted", true, "returnedToTitle", activeScreen instanceof TitleScreen,
				"status", statusSnapshot(client));
		}, 180).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static Path generatedWorldRegistry() {
		return FabricLoader.getInstance().getConfigDir().resolve("minecraft-mcp").resolve("generated-worlds.txt");
	}

	private static void registerGeneratedWorldId(String worldId) throws IOException {
		Path registry = generatedWorldRegistry();
		Files.createDirectories(registry.getParent());
		if (Files.exists(registry) && Files.readAllLines(registry, StandardCharsets.UTF_8).stream().anyMatch(worldId::equals)) return;
		Files.writeString(registry, worldId + System.lineSeparator(), StandardCharsets.UTF_8,
			StandardOpenOption.CREATE, StandardOpenOption.APPEND);
	}

	private static boolean isGeneratedWorldId(String worldId) {
		try {
			Path registry = generatedWorldRegistry();
			return Files.exists(registry) && Files.readAllLines(registry, StandardCharsets.UTF_8).stream().anyMatch(worldId::equals);
		} catch (IOException ignored) {
			return false;
		}
	}

	private static Map<String, Object> worldSummary(LevelSummary summary) {
		return Map.of(
			"id", summary.getLevelId(),
			"name", summary.getLevelName(),
			"lastPlayed", summary.getLastPlayed(),
			"gameMode", summary.getGameMode().getName(),
			"hardcore", summary.isHardcore(),
			"locked", summary.isLocked(),
			"compatible", summary.isCompatible(),
			"generatedByMcp", isGeneratedWorldId(summary.getLevelId())
		);
	}

	private static void loadWorldSnapshot(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/load-snapshot".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		try {
			byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
			if (body.length > MAX_BODY_BYTES) {
				respond(exchange, 413, Map.of("error", "Request body is too large"));
				return;
			}
			input = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected a JSON object with worldId"));
			return;
		}
		if (!input.has("worldId") || !input.get("worldId").isJsonPrimitive() || !input.getAsJsonPrimitive("worldId").isString()) {
			respond(exchange, 400, Map.of("error", "worldId must be a string"));
			return;
		}
		String worldId = input.get("worldId").getAsString();
		if (!isSafeWorldId(worldId)) {
			respond(exchange, 400, Map.of("error", "worldId must be one local folder name without path separators or control characters"));
			return;
		}
		try {
			if (!isWorldAllowlisted(worldId)) {
				respond(exchange, 403, Map.of("error", "World is not allowlisted. Add its exact folder ID to the local world allowlist."));
				return;
			}
		} catch (IOException exception) {
			respond(exchange, 403, Map.of("error", "World allowlist is missing or unreadable. Create it in the local Minecraft MCP config directory."));
			return;
		}

		AtomicBoolean openAttempted = new AtomicBoolean(false);
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before loading a world snapshot");
			return client.getLevelSource();
		}).thenCompose(storage -> {
			CompletableFuture<String> copy = CompletableFuture.supplyAsync(() -> {
				try { return copyWorldToSnapshot(storage, worldId); }
				catch (IOException exception) { throw new java.util.concurrent.CompletionException(exception); }
			});
			return copy.thenCompose(snapshotId -> callOnClientThread(() -> {
				Minecraft client = Minecraft.getInstance();
				if (client.player != null || client.level != null) throw new IllegalStateException("A world became active while the snapshot was being prepared");
				WorldOpenFlows flows = client.createWorldOpenFlows();
				openAttempted.set(true);
				disablePauseOnLostFocusForAutomation(client);
				flows.openWorld(snapshotId, () -> {});
				return Map.<String, Object>of("accepted", true, "sourceWorldId", worldId, "snapshotWorldId", snapshotId,
					"message", "Loading started. Poll get_game_status until worldReady is true.");
			}).whenComplete((result, error) -> {
				if (error != null && !openAttempted.get()) cleanupGeneratedWorldIfAtSafeMenu(storage, snapshotId);
			}));
		}).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static void editWorldSnapshot(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/edit-snapshot".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		String worldId;
		try {
			JsonObject input = readSmallJsonObject(exchange);
			if (!input.has("worldId") || !input.get("worldId").isJsonPrimitive() || !input.getAsJsonPrimitive("worldId").isString()) {
				throw new IllegalArgumentException("Expected a world ID");
			}
			worldId = input.get("worldId").getAsString();
			if (!isSafeWorldId(worldId)) throw new IllegalArgumentException("Invalid world ID");
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected one exact local world folder ID"));
			return;
		}
		try {
			if (!isWorldAllowlisted(worldId)) {
				respond(exchange, 403, Map.of("error", "World is not allowlisted. Add its exact folder ID to the local world allowlist."));
				return;
			}
		} catch (IOException exception) {
			respond(exchange, 403, Map.of("error", "World allowlist is missing or unreadable. Create it in the local Minecraft MCP config directory."));
			return;
		}
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before editing a world snapshot");
			return client.getLevelSource();
		}).thenCompose(storage -> CompletableFuture.supplyAsync(() -> {
			try { return copyWorldToSnapshot(storage, worldId); }
			catch (IOException exception) { throw new java.util.concurrent.CompletionException(exception); }
		}).thenCompose(snapshotId -> callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("A world became active while the snapshot was being prepared");
			var access = client.getLevelSource().createAccess(snapshotId);
			try {
				Screen editor = EditWorldScreen.create(client, access,
				accepted -> client.setScreenAndShow(new SelectWorldScreen(new TitleScreen())));
			client.setScreenAndShow(editor);
			} catch (IOException | RuntimeException exception) {
				try { access.close(); } catch (IOException closeError) { exception.addSuppressed(closeError); }
				throw exception;
			}
			return Map.<String, Object>of("accepted", true, "sourceWorldId", worldId, "snapshotWorldId", snapshotId,
				"screen", "EditWorldScreen", "message", "A disposable copy is open in the Edit World menu. Save or cancel, then use open_generated_world to load the edited copy.");
		}).whenComplete((result, error) -> {
				if (error != null) cleanupGeneratedWorldIfAtSafeMenu(storage, snapshotId);
		}))).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static void openGeneratedWorld(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/open-generated".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		String worldId;
		try {
			JsonObject input = readSmallJsonObject(exchange);
			if (!input.has("worldId") || !input.get("worldId").isJsonPrimitive() || !input.getAsJsonPrimitive("worldId").isString()) {
				throw new IllegalArgumentException("Expected a world ID");
			}
			worldId = input.get("worldId").getAsString();
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected one generated world ID"));
			return;
		}
		if (!isSafeWorldId(worldId) || !isGeneratedWorldId(worldId)) {
			respond(exchange, 403, Map.of("error", "Only a world created by Minecraft MCP can be opened by this tool"));
			return;
		}
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before opening a generated world");
			disablePauseOnLostFocusForAutomation(client);
			client.createWorldOpenFlows().openWorld(worldId, () -> {});
			return Map.<String, Object>of("accepted", true, "worldId", worldId,
				"message", "Loading started. Poll get_game_status until worldReady is true.");
		}, 50).whenComplete((result, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", rootMessage(error)));
			else respondQuietly(exchange, 202, result);
		});
	}

	private static boolean isSafeWorldId(String id) {
		if (id.isBlank() || id.length() > 128 || id.equals(".") || id.equals("..") || id.contains("/") || id.contains("\\") || id.contains(":")) return false;
		return id.chars().noneMatch(character -> Character.isISOControl(character));
	}

	private static boolean isWorldAllowlisted(String worldId) throws IOException {
		Path allowlist = FabricLoader.getInstance().getConfigDir().resolve("minecraft-mcp").resolve("world-allowlist.txt");
		return Files.readAllLines(allowlist, StandardCharsets.UTF_8).stream()
			.map(String::trim).filter(line -> !line.isEmpty() && !line.startsWith("#")).anyMatch(worldId::equals);
	}

	private static void cleanupGeneratedWorldIfAtSafeMenu(LevelStorageSource storage, String worldId) {
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			return client.player == null && client.level == null
				&& (activeScreen instanceof TitleScreen || activeScreen instanceof SelectWorldScreen);
		})
			.thenAccept(isInactive -> {
				if (!isInactive) return;
				CompletableFuture.runAsync(() -> {
					try { deleteGeneratedWorld(storage, worldId); }
					catch (IOException ignored) { }
				});
			});
	}

	private static synchronized String copyWorldToSnapshot(LevelStorageSource storage, String worldId) throws IOException {
		Path saves = storage.getBaseDir().toAbsolutePath().normalize();
		Path source = saves.resolve(worldId).normalize();
		if (!source.startsWith(saves) || !Files.isDirectory(source, LinkOption.NOFOLLOW_LINKS)
			|| !Files.isRegularFile(source.resolve("level.dat"), LinkOption.NOFOLLOW_LINKS)) {
			throw new IOException("World save was not found or has no level.dat");
		}
		String snapshotId = "mcp_snapshot_" + UUID.randomUUID().toString().replace("-", "");
		Path destination = saves.resolve(snapshotId).normalize();
		if (!destination.startsWith(saves)) throw new IOException("Invalid snapshot path");
		try (var sourceLock = storage.createAccess(worldId)) {
			if (!sourceLock.hasWorldData()) throw new IOException("World save has no loadable world data");
			Files.createDirectory(destination);
			long copiedBytes = 0L;
			int copiedEntries = 0;
			try (var paths = Files.walk(source)) {
				var iterator = paths.iterator();
				while (iterator.hasNext()) {
					Path path = iterator.next();
					if (++copiedEntries > MAX_SNAPSHOT_ENTRIES) throw new IOException("World snapshot contains too many filesystem entries");
					if (Files.isSymbolicLink(path)) throw new IOException("World snapshot refused a symbolic link");
					Path relative = source.relativize(path);
					Path target = destination.resolve(relative).normalize();
					if (!target.startsWith(destination)) throw new IOException("World snapshot path escaped its target");
					if (relative.toString().isEmpty()) continue;
					if (path.getFileName().toString().equals("session.lock")) continue;
					if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
						Files.createDirectories(target);
					} else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
						long fileBytes = Files.size(path);
						if (fileBytes > MAX_SNAPSHOT_BYTES - copiedBytes) throw new IOException("World snapshot exceeds the 1 GiB copy limit");
						Files.copy(path, target, StandardCopyOption.COPY_ATTRIBUTES);
						copiedBytes += fileBytes;
					} else {
						throw new IOException("World snapshot encountered an unsupported filesystem entry: " + relative);
					}
				}
			}
		} catch (IOException exception) {
			deleteTree(destination);
			throw exception;
		} catch (RuntimeException exception) {
			deleteTree(destination);
			throw exception;
		}
		try {
			registerGeneratedWorldId(snapshotId);
		} catch (IOException exception) {
			deleteTree(destination);
			throw exception;
		}
		return snapshotId;
	}

	private static void deleteGeneratedWorld(LevelStorageSource storage, String worldId) throws IOException {
		if (!isSafeWorldId(worldId) || !isGeneratedWorldId(worldId)) throw new IOException("World was not created by Minecraft MCP");
		Path saves = storage.getBaseDir().toAbsolutePath().normalize();
		Path target = saves.resolve(worldId).normalize();
		if (!target.startsWith(saves) || !Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
			throw new IOException("Generated world folder was not found");
		}
		try (var access = storage.createAccess(worldId)) {
			if (!access.hasWorldData()) throw new IOException("Generated world has no loadable world data");
		}
		deleteTree(target);
		Path registry = generatedWorldRegistry();
		List<String> remaining = Files.exists(registry)
			? Files.readAllLines(registry, StandardCharsets.UTF_8).stream().filter(id -> !id.equals(worldId)).toList()
			: List.of();
		Files.write(registry, remaining, StandardCharsets.UTF_8);
	}

	private static void cleanupGeneratedWorld(HttpExchange exchange) throws IOException {
		if (!"/v1/worlds/cleanup-generated".equals(exchange.getRequestURI().getPath())) {
			respond(exchange, 404, Map.of("error", "Unknown endpoint"));
			return;
		}
		if (!"POST".equals(exchange.getRequestMethod())) {
			respond(exchange, 405, Map.of("error", "Use POST"));
			return;
		}
		if (!authorized(exchange)) return;
		JsonObject input;
		try {
			input = readSmallJsonObject(exchange);
			if (!input.has("worldId") || !input.get("worldId").isJsonPrimitive() || !input.getAsJsonPrimitive("worldId").isString()) {
				throw new IllegalArgumentException("Expected worldId");
			}
		} catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException exception) {
			respond(exchange, 400, Map.of("error", "Expected the exact generated world ID from list_worlds"));
			return;
		}
		String worldId = input.get("worldId").getAsString();
		if (!isSafeWorldId(worldId) || !isGeneratedWorldId(worldId)) {
			respond(exchange, 403, Map.of("error", "Only worlds created by Minecraft MCP can be cleaned up"));
			return;
		}
		callOnClientThread(() -> {
			Minecraft client = Minecraft.getInstance();
			if (client.player != null || client.level != null) throw new IllegalStateException("Return to the title screen before cleaning up a generated world");
			return client.getLevelSource();
		}).thenCompose(storage -> CompletableFuture.runAsync(() -> {
			try { deleteGeneratedWorld(storage, worldId); }
			catch (IOException exception) { throw new java.util.concurrent.CompletionException(exception); }
		})).whenComplete((ignored, error) -> {
			if (error != null) respondQuietly(exchange, 409, Map.of("error", safeMessage(error)));
			else respondQuietly(exchange, 200, Map.of("ok", true, "worldId", worldId, "deleted", true));
		});
	}

	private static void deleteTree(Path root) throws IOException {
		if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
		try (var paths = Files.walk(root)) {
			for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
		}
	}

	private static boolean authorized(HttpExchange exchange) throws IOException {
		String header = exchange.getRequestHeaders().getFirst("Authorization");
		String supplied = header != null && header.startsWith("Bearer ") ? header.substring(7) : "";
		if (!MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8))) {
			respond(exchange, 401, Map.of("error", "Missing or invalid bearer token"));
			return false;
		}
		return true;
	}

	private static <T> CompletableFuture<T> callOnClientThread(java.util.concurrent.Callable<T> action) {
		return callOnClientThread(action, 5);
	}

	private static <T> CompletableFuture<T> callOnClientThread(java.util.concurrent.Callable<T> action, int timeoutSeconds) {
		CompletableFuture<T> future = new CompletableFuture<>();
		AtomicBoolean dispatchClaimed = new AtomicBoolean();
		var timeout = CLIENT_DISPATCH_TIMEOUTS.schedule(() -> {
			if (dispatchClaimed.compareAndSet(false, true)) {
				future.completeExceptionally(new java.util.concurrent.TimeoutException(
					"Minecraft client thread did not process the request within " + timeoutSeconds + " seconds"));
			}
		}, timeoutSeconds, TimeUnit.SECONDS);
		try {
			Minecraft.getInstance().execute(() -> {
				if (!dispatchClaimed.compareAndSet(false, true)) return;
				timeout.cancel(false);
				try { future.complete(action.call()); }
				catch (Throwable throwable) { future.completeExceptionally(throwable); }
			});
		} catch (Throwable throwable) {
			if (dispatchClaimed.compareAndSet(false, true)) {
				timeout.cancel(false);
				future.completeExceptionally(throwable);
			}
		}
		return future;
	}

	private static String loadOrCreateToken() throws IOException {
		Path directory = FabricLoader.getInstance().getConfigDir().resolve("minecraft-mcp");
		Files.createDirectories(directory);
		Path tokenFile = directory.resolve("bridge-token.txt");
		Path allowlist = directory.resolve("world-allowlist.txt");
		if (Files.notExists(allowlist)) Files.writeString(allowlist, "# Add exact local save folder IDs that may be opened as disposable snapshots.\n", StandardCharsets.UTF_8);
		if (Files.exists(tokenFile)) {
			String existing = Files.readString(tokenFile, StandardCharsets.UTF_8).trim();
			if (existing.isEmpty()) throw new IOException("Minecraft MCP token file is empty");
			restrictTokenPermissions(tokenFile);
			return existing;
		}
		byte[] bytes = new byte[32];
		new SecureRandom().nextBytes(bytes);
		String generated = HexFormat.of().formatHex(bytes);
		Files.writeString(tokenFile, generated + System.lineSeparator(), StandardCharsets.UTF_8);
		restrictTokenPermissions(tokenFile);
		return generated;
	}

	private static void restrictTokenPermissions(Path tokenFile) throws IOException {
		try { Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------")); }
		catch (UnsupportedOperationException ignored) { /* Windows does not expose POSIX file permissions. */ }
	}

	private static String rootMessage(Throwable throwable) {
		Throwable root = throwable;
		while (root.getCause() != null) root = root.getCause();
		String message = root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
		for (String privatePath : List.of(
			System.getProperty("user.home", ""),
			FabricLoader.getInstance().getGameDir().toAbsolutePath().normalize().toString(),
			FabricLoader.getInstance().getConfigDir().toAbsolutePath().normalize().toString())) {
			if (!privatePath.isBlank()) message = message.replace(privatePath, "<local-path>");
		}
		message = message.replaceAll("(?i)(?:[A-Z]:\\\\Users\\\\[^\\s:]+|/(?:home|Users)/[^\\s:]+)", "<local-path>");
		return message.length() > 240 ? message.substring(0, 240) : message;
	}

	private static void respondQuietly(HttpExchange exchange, int code, Object body) {
		try { respond(exchange, code, body); } catch (IOException ignored) { exchange.close(); }
	}

	private static void respondPngQuietly(HttpExchange exchange, byte[] bytes) {
		try {
			exchange.getResponseHeaders().set("Content-Type", "image/png");
			exchange.getResponseHeaders().set("Cache-Control", "no-store");
			exchange.sendResponseHeaders(200, bytes.length);
			try (var output = exchange.getResponseBody()) { output.write(bytes); }
		} catch (IOException ignored) { exchange.close(); }
	}

	private static void respond(HttpExchange exchange, int code, Object body) throws IOException {
		byte[] bytes = new com.google.gson.Gson().toJson(body).getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
		exchange.getResponseHeaders().set("Cache-Control", "no-store");
		exchange.sendResponseHeaders(code, bytes.length);
		try (var output = exchange.getResponseBody()) { output.write(bytes); }
	}
}
