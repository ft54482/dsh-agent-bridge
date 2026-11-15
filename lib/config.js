import { isIP } from "node:net";
import path from "node:path";

/** Default secret path (0600). The file content is never logged. */
export const DEFAULT_SECRET_FILE = "/home/dsops/.dsh/bridge.secret";

/** Default MCP endpoint path on the loopback listener. */
export const DEFAULT_MCP_PATH = "/mcp";

/** Default loopback port for the bridge listener. */
export const DEFAULT_PORT = 17300;

const KNOWN_KEYS = new Set([
  "host",
  "port",
  "path",
  "secretFile",
  "secretMinLength",
  "workspaceAllowlist",
  "workspaceSlugs",
  "promptPerMinute",
  "requestsPerMinute",
  "followDefaultTimeoutMs",
  "followMaxTimeoutMs",
  "followMaxEvents",
  "readFileMaxBytes",
  "artifactsLimit",
  "artifactsMaxDepth",
  "maxBodyBytes"
]);

/** Whether a literal address is loopback (127.0.0.0/8 or ::1). */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || host.length === 0) return false;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

function requireInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}], got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("workspaceAllowlist must be a non-empty array of absolute paths");
  }
  const unique = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("workspaceAllowlist entries must be non-empty strings");
    }
    if (!path.isAbsolute(entry)) {
      throw new Error(`workspaceAllowlist entry must be absolute: ${JSON.stringify(entry)}`);
    }
    const normalized = path.resolve(entry);
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

/** Deployment-owned aliases; no built-in workspace IDs or project roots. */
function normalizeWorkspaceSlugs(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspaceSlugs must be an object");
  }
  const result = {};
  for (const [slug, entry] of Object.entries(value)) {
    if (!slug.trim() || slug.length > 80 || entry === null || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["id", "path", "title"].includes(key))
      || ["id", "path", "title"].some((key) => typeof entry[key] !== "string" || !entry[key].trim())
      || !path.isAbsolute(entry.path)) {
      throw new Error("workspaceSlugs entries must be {id, path, title} with non-empty strings and an absolute path");
    }
    Object.defineProperty(result, slug, {
      value: { id: entry.id, path: path.resolve(entry.path), title: entry.title },
      enumerable: true, writable: true, configurable: true
    });
  }
  return result;
}

/**
 * Validate and normalize raw plugin config. Throws on any invalid or unknown
 * field; callers fail closed (no listener) rather than starting half-configured.
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("config must be an object");
  }
  const input = raw ?? {};
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown config field: ${key}`);
  }

  const host = input.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`host must be a loopback literal (127.0.0.0/8 or ::1), got ${JSON.stringify(host)}`);
  }

  const endpointPath = input.path ?? DEFAULT_MCP_PATH;
  if (typeof endpointPath !== "string" || !endpointPath.startsWith("/") || endpointPath.length > 200 || endpointPath.includes(" ")) {
    throw new Error(`path must be an absolute URL path without spaces, got ${JSON.stringify(endpointPath)}`);
  }

  const secretFile = input.secretFile ?? DEFAULT_SECRET_FILE;
  if (typeof secretFile !== "string" || !path.isAbsolute(secretFile)) {
    throw new Error("secretFile must be an absolute path");
  }

  return {
    host,
    port: requireInteger(input.port, "port", DEFAULT_PORT, 1, 65535),
    path: endpointPath,
    secretFile,
    secretMinLength: requireInteger(input.secretMinLength, "secretMinLength", 32, 16, 4096),
    workspaceAllowlist: normalizeAllowlist(input.workspaceAllowlist),
    workspaceSlugs: normalizeWorkspaceSlugs(input.workspaceSlugs),
    promptPerMinute: requireInteger(input.promptPerMinute, "promptPerMinute", 30, 1, 100000),
    requestsPerMinute: requireInteger(input.requestsPerMinute, "requestsPerMinute", 240, 1, 100000),
    followDefaultTimeoutMs: requireInteger(input.followDefaultTimeoutMs, "followDefaultTimeoutMs", 8000, 500, 120000),
    followMaxTimeoutMs: requireInteger(input.followMaxTimeoutMs, "followMaxTimeoutMs", 30000, 500, 300000),
    followMaxEvents: requireInteger(input.followMaxEvents, "followMaxEvents", 200, 1, 2000),
    readFileMaxBytes: requireInteger(input.readFileMaxBytes, "readFileMaxBytes", 262144, 1, 8 * 1024 * 1024),
    artifactsLimit: requireInteger(input.artifactsLimit, "artifactsLimit", 200, 1, 5000),
    artifactsMaxDepth: requireInteger(input.artifactsMaxDepth, "artifactsMaxDepth", 5, 1, 32),
    maxBodyBytes: requireInteger(input.maxBodyBytes, "maxBodyBytes", 1024 * 1024, 1024, 16 * 1024 * 1024)
  };
}
