#!/usr/bin/env node
// Cross-platform, read-only acceptance checks for the dsh-agent-bridge MCP
// endpoint. Companion to the POSIX-only scripts/verify-bridge.sh.
//
// READ-ONLY by design: no sessions are created, no prompts are sent, no files
// are written and no service is restarted. Every request below is an MCP
// handshake or a read-only tool call against the configured loopback endpoint.
//
// Requires Node.js >= 20 and uses only Node builtins plus the global fetch().
// Usage: node scripts/verify-bridge.mjs [options]  (see --help)
//
// The bearer credential is read from DSH_BRIDGE_SECRET or from the file named
// by DSH_BRIDGE_SECRET_FILE. It is never printed and is redacted from all
// output, including error messages.

import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MCP_URL = "http://127.0.0.1:17300/mcp";
const EXPECTED_SERVER_NAME = "dsh-agent-bridge";
const EXPECTED_TOOL_COUNT = 12;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 120000;
const MIN_SECRET_BYTES = 32;
const TRAVERSAL_PROBE_NAME = "dsh-bridge-verify-escape";

const runtime = {
  json: false,
  endpoint: DEFAULT_MCP_URL,
  secret: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  baseDir: ""
};

const results = [];

class CliError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function helpText() {
  return [
    "Usage: node scripts/verify-bridge.mjs [options]",
    "",
    "Read-only acceptance checks for the dsh-agent-bridge MCP endpoint.",
    "Creates no sessions, sends no prompts, writes no files.",
    "",
    "Options:",
    "  --base-dir <path>         Directory used for the relative-read check.",
    "                            Default: $DSH_BRIDGE_BASE_DIR or the current directory.",
    "  --probe-file <relpath>    File inside --base-dir to read (default: this script).",
    "  --expect-workspaces <n>   Require dsh_list_workspaces to report exactly n roots.",
    "  --timeout <ms>            Per-request timeout (default 10000).",
    "  --json                    Print one machine-readable JSON summary.",
    "  -h, --help                Show this help.",
    "",
    "Environment:",
    "  DSH_MCP_URL                  Endpoint (loopback only; default " + DEFAULT_MCP_URL + ").",
    "  DSH_BRIDGE_SECRET            Bearer token value (takes precedence).",
    "  DSH_BRIDGE_SECRET_FILE       File containing the bearer token.",
    "  DSH_BRIDGE_BASE_DIR          Default for --base-dir.",
    "  DSH_BRIDGE_PROBE_FILE        Default for --probe-file.",
    "  DSH_BRIDGE_EXPECT_WORKSPACES Default for --expect-workspaces.",
    "",
    "Exit codes: 0 = every non-skipped check passed, 1 = a check failed,",
    "            2 = bad usage or unusable configuration."
  ].join("\n");
}

function requireInteger(flag, value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new CliError(`${flag} must be an integer in [${minimum}, ${maximum}]`);
  }
  return number;
}

function parseOptions(argv) {
  const options = {
    help: false,
    json: false,
    baseDir: undefined,
    probeFile: undefined,
    expectWorkspaces: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  const valueFlags = new Set(["--base-dir", "--probe-file", "--expect-workspaces", "--timeout"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    if (name === "-h" || name === "--help") {
      options.help = true;
      continue;
    }
    if (name === "--json") {
      options.json = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new CliError(`Unknown argument: ${argument}`);
    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new CliError(`${name} requires a value`);
      if (value.startsWith("--")) throw new CliError(`${name} requires a value`);
    }
    if (value === "") throw new CliError(`${name} requires a non-empty value`);
    if (name === "--base-dir") options.baseDir = value;
    else if (name === "--probe-file") options.probeFile = validateProbeFile(name, value);
    else if (name === "--expect-workspaces") options.expectWorkspaces = requireInteger(name, value, 0, 1000);
    else options.timeoutMs = requireInteger(name, value, 100, MAX_TIMEOUT_MS);
  }
  return options;
}

function validateProbeFile(flag, value) {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new CliError(`${flag} must be a path relative to --base-dir without ".." segments`);
  }
  return value;
}

function resolveEndpoint(raw) {
  const candidate = (raw ?? "").trim() || DEFAULT_MCP_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CliError("DSH_MCP_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:") throw new CliError("DSH_MCP_URL must use plain http on a loopback literal");
  if (parsed.username || parsed.password) throw new CliError("DSH_MCP_URL must not embed credentials");
  if (parsed.search || parsed.hash) throw new CliError("DSH_MCP_URL must not carry a query or fragment");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const loopback =
    (family === 4 && host.startsWith("127.")) ||
    (family === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1"));
  if (!loopback) throw new CliError(`DSH_MCP_URL host must be loopback (127.0.0.0/8 or ::1), got ${host}`);
  return parsed.href;
}

function loadSecret() {
  const direct = (process.env.DSH_BRIDGE_SECRET ?? "").trim();
  if (direct) return { secret: direct, source: "DSH_BRIDGE_SECRET" };
  const file = (process.env.DSH_BRIDGE_SECRET_FILE ?? "").trim();
  if (!file) throw new CliError("Set DSH_BRIDGE_SECRET or DSH_BRIDGE_SECRET_FILE (outside the repository)");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError("Cannot read the credential file named by DSH_BRIDGE_SECRET_FILE");
  }
  const secret = text.trim();
  if (!secret) throw new CliError("Credential file named by DSH_BRIDGE_SECRET_FILE is empty");
  return { secret, source: "DSH_BRIDGE_SECRET_FILE" };
}

function validateSecret(secret) {
  if (/\r|\n/.test(secret)) throw new CliError("Bearer credential must not contain line breaks");
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new CliError(`Bearer credential must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

function redact(value) {
  let text = String(value ?? "");
  if (runtime.secret) text = text.split(runtime.secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}

function brief(value, limit = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function record(name, status, detail = "") {
  const safeDetail = redact(detail);
  results.push({ name, status, detail: safeDetail });
  if (!runtime.json) {
    const suffix = safeDetail ? `  ${safeDetail}` : "";
    console.log(`${status.toUpperCase().padEnd(4)} ${name}${suffix}`);
  }
}

function countStatus(status) {
  return results.filter((item) => item.status === status).length;
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause === undefined || cause === null) return message;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    record(name, outcome.ok ? "pass" : "fail", outcome.detail ?? "");
  } catch (error) {
    record(name, "fail", describeError(error));
  }
}

function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Streamable HTTP servers may answer with SSE frames instead of plain JSON.
  }
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split(/\r?\n/)) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload) continue;
      try {
        return JSON.parse(payload);
      } catch {
        // Keep scanning later frames.
      }
    }
  }
  return null;
}

async function rpc(body, { auth = true, origin } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (auth) headers.authorization = `Bearer ${runtime.secret}`;
  if (origin) headers.origin = origin;
  const response = await fetch(runtime.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(runtime.timeoutMs)
  });
  const text = await response.text();
  return { status: response.status, json: parseJson(text), text };
}

async function callTool(id, name, args = {}) {
  const response = await rpc({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const result = response.json?.result;
  const firstContent = Array.isArray(result?.content) ? result.content[0] : undefined;
  const payload = typeof firstContent?.text === "string" ? firstContent.text : "";
  return { status: response.status, result, payload, parsed: parseJson(payload), text: response.text };
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function probeFileFor(baseDir, explicit) {
  if (explicit) return explicit;
  const scriptPath = fileURLToPath(import.meta.url);
  if (!isInside(baseDir, scriptPath)) return null;
  return toPosixPath(path.relative(baseDir, scriptPath));
}

function localCopyOf(baseDir, relative) {
  try {
    return readFileSync(path.resolve(baseDir, relative), "utf8");
  } catch {
    return null;
  }
}

/** First ancestor of baseDir that is outside every allowlisted root. */
function findEscapePath(baseDir, roots) {
  let current = path.resolve(baseDir);
  const stop = path.parse(current).root;
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === stop) return null;
    current = path.dirname(current);
    if (!roots.some((root) => isInside(root, current))) {
      const relative = path.relative(baseDir, current);
      return path.join(relative, TRAVERSAL_PROBE_NAME);
    }
  }
  return null;
}

function skipFileGuardChecks(reason) {
  record("dsh_read_workspace_file -> relative read", "skip", reason);
  record("dsh_read_workspace_file -> traversal rejected", "skip", reason);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return 0;
  }

  runtime.json = options.json;
  runtime.endpoint = resolveEndpoint(process.env.DSH_MCP_URL);
  const credential = loadSecret();
  validateSecret(credential.secret);
  runtime.secret = credential.secret;
  runtime.timeoutMs = options.timeoutMs;
  const baseDirOption = options.baseDir ?? process.env.DSH_BRIDGE_BASE_DIR ?? process.cwd();
  runtime.baseDir = path.resolve(baseDirOption);
  const expectWorkspacesRaw = options.expectWorkspaces ?? (process.env.DSH_BRIDGE_EXPECT_WORKSPACES || undefined);
  const expectedWorkspaces = expectWorkspacesRaw === undefined
    ? undefined
    : requireInteger("DSH_BRIDGE_EXPECT_WORKSPACES", expectWorkspacesRaw, 0, 1000);
  const probeFileOption = options.probeFile ?? (process.env.DSH_BRIDGE_PROBE_FILE || undefined);
  const probeFile = probeFileFor(
    runtime.baseDir,
    probeFileOption === undefined ? undefined : validateProbeFile("DSH_BRIDGE_PROBE_FILE", probeFileOption)
  );

  if (!runtime.json) {
    console.log("dsh-agent-bridge read-only verification");
    console.log(`  endpoint  : ${runtime.endpoint}`);
    console.log(`  credential: loaded from ${credential.source} (value never printed)`);
    console.log(`  base dir  : ${runtime.baseDir}`);
    console.log("");
  }

  const startedAt = Date.now();
  let nextId = 1;
  const requestId = () => nextId++;
  const state = { serverInfo: null, toolsLoaded: false, tools: [], workspacesOk: false, workspaceRoots: [] };

  await check("no bearer -> 401", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: requestId(), method: "tools/list" }, { auth: false });
    return { ok: response.status === 401, detail: `HTTP ${response.status}` };
  });

  await check("non-loopback Origin -> 403", async () => {
    const response = await rpc(
      { jsonrpc: "2.0", id: requestId(), method: "tools/list" },
      { origin: "https://untrusted.example.com" }
    );
    return { ok: response.status === 403, detail: `HTTP ${response.status}` };
  });

  await check("initialize -> serverInfo", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: requestId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-bridge", version: "1.0.0" }
      }
    });
    const info = response.json?.result?.serverInfo;
    state.serverInfo = info ?? null;
    if (response.status === 200 && info?.name === EXPECTED_SERVER_NAME) {
      return { ok: true, detail: `${info.name} ${info.version ?? "unknown"}` };
    }
    return { ok: false, detail: `HTTP ${response.status}; serverInfo=${brief(JSON.stringify(info ?? null))}` };
  });

  await check("tools/list -> 12 unique tools", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: requestId(), method: "tools/list" });
    const tools = Array.isArray(response.json?.result?.tools) ? response.json.result.tools : [];
    state.tools = tools;
    state.toolsLoaded = response.status === 200 && Array.isArray(response.json?.result?.tools);
    const names = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    const uniqueNames = new Set(names).size;
    const ok = response.status === 200 && tools.length === EXPECTED_TOOL_COUNT && uniqueNames === EXPECTED_TOOL_COUNT;
    return { ok, detail: `${tools.length} tools, ${uniqueNames} unique` };
  });

  if (!state.toolsLoaded) {
    record("create_session exposes workspaceSlug/workspaceId", "skip", "depends on tools/list");
  } else {
    await check("create_session exposes workspaceSlug/workspaceId", async () => {
      const createTool = state.tools.find((tool) => tool?.name === "dsh_create_session");
      const properties = createTool?.inputSchema?.properties ?? {};
      const ok = Boolean(properties.workspaceSlug) && Boolean(properties.workspaceId);
      return { ok, detail: ok ? "" : "missing workspaceSlug and/or workspaceId in inputSchema.properties" };
    });
  }

  await check("dsh_list_workspaces -> allowlisted roots", async () => {
    const response = await callTool(requestId(), "dsh_list_workspaces");
    const parsed = response.parsed;
    const items = Array.isArray(parsed?.items) ? parsed.items : null;
    const reported = parsed?.count;
    state.workspaceRoots = (items ?? []).map((item) => item?.path).filter((value) => typeof value === "string");
    const shapeOk =
      response.status === 200 &&
      response.result?.isError !== true &&
      Number.isInteger(reported) &&
      reported >= 0 &&
      items !== null &&
      items.length === reported;
    if (!shapeOk) {
      state.workspacesOk = false;
      return { ok: false, detail: brief(response.payload || response.text || "unexpected response shape") };
    }
    if (expectedWorkspaces !== undefined && reported !== expectedWorkspaces) {
      state.workspacesOk = false;
      return { ok: false, detail: `count=${reported}, expected ${expectedWorkspaces}` };
    }
    state.workspacesOk = true;
    return { ok: true, detail: `count=${reported}` };
  });

  await check("dsh_list_sessions -> controller.list", async () => {
    const response = await callTool(requestId(), "dsh_list_sessions", { limit: 5 });
    const items = response.parsed?.items;
    const ok = response.status === 200 && response.result?.isError !== true && Array.isArray(items);
    return { ok, detail: ok ? `items=${items.length}` : brief(response.payload || response.text) };
  });

  let fileGuardSkip = "";
  if (!state.workspacesOk) fileGuardSkip = "depends on dsh_list_workspaces";
  else if (state.workspaceRoots.length === 0) fileGuardSkip = "bridge reports no allowlisted workspace roots";
  else if (!existsSync(runtime.baseDir)) fileGuardSkip = `base dir ${runtime.baseDir} does not exist locally`;
  else if (!state.workspaceRoots.some((root) => isInside(root, runtime.baseDir))) {
    fileGuardSkip = `base dir ${runtime.baseDir} is outside the allowlisted roots (environment mismatch, not a failure)`;
  }

  if (fileGuardSkip) {
    skipFileGuardChecks(fileGuardSkip);
  } else {
    if (!probeFile) {
      record(
        "dsh_read_workspace_file -> relative read",
        "skip",
        `no probe file inside ${runtime.baseDir}; pass --probe-file <relative path>`
      );
    } else {
      const localCopy = localCopyOf(runtime.baseDir, probeFile);
      await check("dsh_read_workspace_file -> relative read", async () => {
        const response = await callTool(requestId(), "dsh_read_workspace_file", {
          cwd: runtime.baseDir,
          path: probeFile
        });
        const parsed = response.parsed;
        if (
          response.status !== 200 ||
          response.result?.isError === true ||
          typeof parsed?.content !== "string" ||
          parsed.content.length === 0
        ) {
          return { ok: false, detail: brief(response.payload || response.text || "empty response") };
        }
        if (localCopy !== null && parsed.truncated !== true && parsed.content !== localCopy) {
          const remoteBytes = Buffer.byteLength(parsed.content, "utf8");
          const localBytes = Buffer.byteLength(localCopy, "utf8");
          return { ok: false, detail: `content mismatch (remote ${remoteBytes} bytes, local ${localBytes} bytes)` };
        }
        const bytes = Number.isInteger(parsed.bytes) ? parsed.bytes : Buffer.byteLength(parsed.content, "utf8");
        return { ok: true, detail: `${probeFile} (${bytes} bytes${localCopy !== null ? ", matches local copy" : ""})` };
      });
    }

    const escapePath = findEscapePath(runtime.baseDir, state.workspaceRoots);
    if (!escapePath) {
      record(
        "dsh_read_workspace_file -> traversal rejected",
        "skip",
        "cannot build a probe path outside the allowlisted roots"
      );
    } else {
      await check("dsh_read_workspace_file -> traversal rejected", async () => {
        // The guard reports HTTP 200 + isError:true, not a 4xx, so assert that shape.
        const response = await callTool(requestId(), "dsh_read_workspace_file", {
          cwd: runtime.baseDir,
          path: escapePath
        });
        const forbidden = /FORBIDDEN_WORKSPACE/.test(String(response.payload));
        const ok = response.status === 200 && response.result?.isError === true && forbidden;
        return { ok, detail: `path=${escapePath}; HTTP ${response.status}; ${brief(response.payload, 100)}` };
      });
    }
  }

  const passed = countStatus("pass");
  const failed = countStatus("fail");
  const skipped = countStatus("skip");
  const verdict = failed === 0 ? "PASS" : "FAIL";

  if (runtime.json) {
    console.log(
      JSON.stringify(
        {
          tool: "verify-bridge",
          readOnly: true,
          ok: failed === 0,
          verdict,
          endpoint: runtime.endpoint,
          server: state.serverInfo
            ? { name: state.serverInfo.name ?? null, version: state.serverInfo.version ?? null }
            : null,
          baseDir: runtime.baseDir,
          checks: results,
          summary: { passed, failed, skipped, total: results.length },
          durationMs: Date.now() - startedAt
        },
        null,
        2
      )
    );
  } else {
    console.log("");
    console.log(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log(verdict === "PASS" ? "VERIFY_BRIDGE PASS" : `VERIFY_BRIDGE FAIL (${failed} failed)`);
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    // process.exitCode (not process.exit) lets Node close sockets cleanly.
    process.exitCode = code;
  })
  .catch((error) => {
    const code = error instanceof CliError ? error.exitCode : 1;
    const message = redact(error instanceof Error ? error.message : String(error));
    if (process.argv.slice(2).includes("--json")) {
      console.log(JSON.stringify({ tool: "verify-bridge", readOnly: true, ok: false, error: message }, null, 2));
    } else {
      console.error(`verify-bridge: ${message}`);
    }
    process.exitCode = code;
  });
