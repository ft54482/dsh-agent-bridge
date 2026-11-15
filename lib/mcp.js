import http from "node:http";
import { parseBearer, safeEqualSecret } from "./auth.js";

/** Supported MCP protocol revisions, newest first. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const LOOPBACK_ORIGIN_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(body);
}

function sendEmpty(response, status, extraHeaders = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...extraHeaders });
  response.end();
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(Object.assign(new Error("request body too large"), { code: "TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the loopback Streamable-HTTP MCP carrier. It is deliberately
 * stateless: no Mcp-Session-Id is issued, so any MCP client may POST
 * JSON-RPC requests to the endpoint with a bearer token.
 */
export function createMcpServer({ config, secretStore, tools, logger }) {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  async function handleRpc(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new RpcError(-32600, "invalid request");
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (typeof method !== "string") throw new RpcError(-32600, "invalid request: method must be a string");

    const result = await dispatch(method, params ?? {});
    if (isNotification) return undefined;
    return { jsonrpc: "2.0", id, result };
  }

  async function dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dsh-agent-bridge", version: "0.2.2" },
          instructions:
            "Loopback bridge to this DSH host. Tools drive the same Web Sessions a human sees in the DSH UI."
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return {};
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations
          }))
        };
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") throw new RpcError(-32602, "tools/call requires a tool name");
        const tool = toolMap.get(name);
        if (tool === undefined) throw new RpcError(-32602, `unknown tool: ${name}`);
        const startedAt = Date.now();
        let outcome;
        try {
          const value = await tool.handler(params?.arguments ?? {});
          outcome = { content: [{ type: "text", text: stringifyValue(value) }], isError: false };
          if (value !== null && typeof value === "object" && !Array.isArray(value)) outcome.structuredContent = value;
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "HOST_ERROR";
          const message = sanitizeMessage(error);
          logger.warn("dsh-agent-bridge: tool %s failed code=%s", name, code);
          outcome = {
            content: [{ type: "text", text: `ERROR ${code}: ${message}` }],
            isError: true
          };
        }
        logger.info("dsh-agent-bridge: tool=%s ms=%d ok=%s", name, Date.now() - startedAt, String(outcome.isError !== true));
        return outcome;
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  async function handleHttp(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== config.path) {
      sendEmpty(response, 404);
      return;
    }
    if (!originAllowed(request)) {
      logger.warn("dsh-agent-bridge: rejected cross-origin request from %s", String(request.headers.origin).slice(0, 200));
      sendEmpty(response, 403);
      return;
    }
    if (request.method !== "POST") {
      sendEmpty(response, 405, { allow: "POST" });
      return;
    }

    const expected = await secretStore.get();
    const provided = parseBearer(request.headers.authorization);
    if (expected === null || !safeEqualSecret(expected, provided ?? "")) {
      logger.warn("dsh-agent-bridge: unauthorized MCP request from %s", request.socket?.remoteAddress ?? "unknown");
      sendJson(response, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="dsh-agent-bridge"' });
      return;
    }

    const contentType = String(request.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().includes("application/json")) {
      sendEmpty(response, 415);
      return;
    }

    let body;
    try {
      body = await readBody(request, config.maxBodyBytes);
    } catch (error) {
      sendEmpty(response, error?.code === "TOO_LARGE" ? 413 : 400);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }

    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const responses = [];
    let sawNotification = false;
    for (const message of requests) {
      try {
        const reply = await handleRpc(message);
        if (reply === undefined) sawNotification = true;
        else responses.push(reply);
      } catch (error) {
        const id = message !== null && typeof message === "object" && !Array.isArray(message) ? message.id ?? null : null;
        if (error instanceof RpcError) {
          responses.push({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
        } else {
          logger.warn("dsh-agent-bridge: internal error: %s", sanitizeMessage(error));
          responses.push({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
        }
      }
    }

    if (responses.length === 0) {
      sendEmpty(response, sawNotification ? 202 : 204);
      return;
    }
    sendJson(response, 200, Array.isArray(parsed) ? responses : responses[0]);
  }

  const server = http.createServer((request, response) => {
    handleHttp(request, response).catch((error) => {
      logger.warn("dsh-agent-bridge: request failed: %s", sanitizeMessage(error));
      if (!response.headersSent) sendEmpty(response, 500);
      else response.destroy();
    });
  });
  server.on("clientError", (error, socket) => {
    logger.warn("dsh-agent-bridge: client error: %s", sanitizeMessage(error));
    socket.destroy();
  });

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host: config.host, port: config.port });
      });
      const address = server.address();
      return { host: config.host, port: address.port, path: config.path, url: `http://${formatHost(config.host)}:${address.port}${config.path}` };
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function stringifyValue(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return "";
    return text.length > 512 * 1024 ? `${text.slice(0, 512 * 1024)}\n[truncated ${text.length - 512 * 1024} bytes]` : text;
  } catch {
    return String(value);
  }
}

/** Strip transport-level detail (absolute paths are allowed) and newlines from logs. */
export function sanitizeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll("\n", " ").slice(0, 300);
}

