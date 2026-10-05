import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.MINECRAFT_MCP_URL ?? "http://127.0.0.1:8765";
const tokenFile = process.env.MINECRAFT_MCP_TOKEN_FILE
  ?? resolve(projectRoot, "run/config/minecraft-mcp/bridge-token.txt");

function requireLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MINECRAFT_MCP_URL must be a valid loopback URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password) {
    throw new Error("MINECRAFT_MCP_URL must use plain HTTP on the local loopback interface");
  }
  return url;
}

async function request(path, headers = {}) {
  try {
    return await fetch(new URL(path, baseUrl), {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Could not reach the local Minecraft bridge within 5 seconds");
  }
}

function requireJson(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expectedStatus}`);
  }
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error(`${label} did not return JSON`);
  }
}

async function main() {
  requireLoopbackUrl(baseUrl);

  const healthResponse = await request("/health");
  requireJson(healthResponse, 200, "Bridge health check");
  const health = await healthResponse.json();
  if (health?.ok !== true || health?.service !== "minecraft-mcp") {
    throw new Error("Bridge health response did not match the expected contract");
  }
  console.log("PASS bridge health");

  const unauthorizedResponse = await request("/v1/status");
  if (unauthorizedResponse.status !== 401) {
    throw new Error(`Unauthenticated status request returned HTTP ${unauthorizedResponse.status}; expected 401`);
  }
  console.log("PASS unauthorized status request rejected");

  let token;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    throw new Error("Bridge token file could not be read; set MINECRAFT_MCP_TOKEN_FILE if needed");
  }
  if (!token) throw new Error("Bridge token file is empty");

  const statusResponse = await request("/v1/status", { Authorization: `Bearer ${token}` });
  requireJson(statusResponse, 200, "Authenticated status request");
  const status = await statusResponse.json();
  if (typeof status?.connected !== "boolean" || typeof status?.worldReady !== "boolean"
    || typeof status?.screen !== "string" || typeof status?.playerPresent !== "boolean"
    || typeof status?.worldPresent !== "boolean") {
    throw new Error("Authenticated status response did not match the expected contract");
  }
  console.log("PASS authenticated status contract");
  console.log("Smoke checks passed. No game actions were performed.");
}

main().catch((error) => {
  console.error(`Smoke check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
