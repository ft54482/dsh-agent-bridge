import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SlidingWindow } from "./rate-limit.js";
import { collectArtifacts, globToRegExp, isInside, pathWithinRoots, resolveAllowedDir } from "./paths.js";
import {
  mapHostError,
  normalizeQueueAction,
  promptRequestId,
  QueueValidationError,
  steerRequestId,
  summarizeQueue
} from "./queue.js";
import { defaultSessionTitle, normalizeSource, SourceRegistry, SourceValidationError } from "./source.js";

class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function badRequest(message) {
  return new ToolError("BAD_REQUEST", message);
}

function requireString(value, name, { maximum = 4000 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) throw badRequest(`${name} must be a non-empty string`);
  if (value.length > maximum) throw badRequest(`${name} exceeds ${maximum} characters`);
  return value;
}

function optionalString(value, name, options) {
  if (value === undefined) return undefined;
  return requireString(value, name, options);
}

function optionalInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw badRequest(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${name} must be a boolean`);
  return value;
}

function sanitizeHostError(error) {
  if (error instanceof ToolError) return error;
  // One mapping table for both the tools and the queue layer, so a Host code
  // added in a new DSH release is classified once (lib/queue.js).
  const { code, remoteCode } = mapHostError(error);
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(code, message.replaceAll("\n", " ").slice(0, 600), remoteCode === undefined ? undefined : { remoteCode });
}

async function withSignal(milliseconds, callback) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref?.();
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function publicSummary(item, sources) {
  const recorded = sources?.get(item.sessionId);
  return {
    sessionId: item.sessionId,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
    running: item.running,
    blank: item.blank,
    agentAvailable: item.agentAvailable,
    ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
    ...(item.origin === undefined ? {} : { origin: item.origin }),
    ...(recorded === undefined ? {} : { source: recorded.source })
  };
}

function parseModelSelection(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const [provider, model] = value.split("/");
    if (!provider || !model) throw badRequest('model must be "provider/model" or an object {provider, model, reasoningEffort?}');
    return { provider, model };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("model must be a string or an object");
  }
  const provider = requireString(value.provider, "model.provider", { maximum: 200 });
  const model = requireString(value.model, "model.model", { maximum: 200 });
  const reasoningEffort = optionalString(value.reasoningEffort, "model.reasoningEffort", { maximum: 100 });
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

/** Build the MCP tool definitions backed by the Host Session Controller. */

async function pathsEqual(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/**
 * Resolve a Host workspace for session.create.
 * Order: explicit workspaceId > workspaceSlug > resolveByPath(cwd) > list().find(path).
 * Returns { workspaceId, workspaceTitle, path } or null when unresolved.
 * Throws ToolError BAD_REQUEST on explicit/slug mismatch.
 */
export async function resolveWorkspaceForCreate({ registry, cwd, workspaceId, workspaceSlug, workspaceSlugs = {} }) {
  if (workspaceSlug !== undefined && !Object.hasOwn(workspaceSlugs, workspaceSlug)) {
    throw badRequest(`unknown workspaceSlug: ${workspaceSlug}`);
  }
  if (!registry) return null;

  if (workspaceId !== undefined) {
    if (typeof registry.get !== "function") {
      throw badRequest("workspaceRegistry.get unavailable; cannot honor workspaceId");
    }
    const ws = registry.get(workspaceId);
    if (!ws) throw badRequest(`workspaceId not found: ${workspaceId}`);
    if (!(await pathsEqual(ws.path, cwd))) {
      throw badRequest(`workspaceId path mismatch: workspace.path=${ws.path} cwd=${cwd}`);
    }
    return { workspaceId: String(ws.id), workspaceTitle: ws.title, path: ws.path };
  }

  if (workspaceSlug !== undefined) {
    const mapped = workspaceSlugs[workspaceSlug];
    if (!mapped) throw badRequest(`unknown workspaceSlug: ${workspaceSlug}`);
    if (typeof registry.get === "function") {
      const ws = registry.get(mapped.id);
      if (ws) {
        if (!(await pathsEqual(ws.path, cwd))) {
          throw badRequest(`workspaceSlug path mismatch: slug maps to ${ws.path} but cwd=${cwd}`);
        }
        return { workspaceId: String(ws.id), workspaceTitle: ws.title, path: ws.path };
      }
    }
    if (!(await pathsEqual(mapped.path, cwd))) {
      throw badRequest(`workspaceSlug path mismatch: slug maps to ${mapped.path} but cwd=${cwd}`);
    }
    return { workspaceId: mapped.id, workspaceTitle: mapped.title, path: mapped.path };
  }

  if (typeof registry.resolveByPath === "function") {
    try {
      const ws = await registry.resolveByPath(cwd);
      if (ws && ws.id) {
        return { workspaceId: String(ws.id), workspaceTitle: ws.title, path: ws.path };
      }
    } catch {
      // resolveByPath rejects on missing path; fall through to list().
    }
  }

  if (typeof registry.list === "function") {
    const rows = registry.list() || [];
    const exact = rows.find((w) => w && w.path === cwd);
    if (exact && exact.id) {
      return { workspaceId: String(exact.id), workspaceTitle: exact.title, path: exact.path };
    }
    for (const w of rows) {
      if (w && w.id && (await pathsEqual(w.path, cwd))) {
        return { workspaceId: String(w.id), workspaceTitle: w.title, path: w.path };
      }
    }
  }

  return null;
}

export function createTools({ ctx, config, roots }) {
  const promptLimiter = new SlidingWindow(config.promptPerMinute);
  const requestLimiter = new SlidingWindow(config.requestsPerMinute);
  const sources = new SourceRegistry();

  const controller = () => ctx.sessionController;

  function takeLimit(bucket) {
    if (!requestLimiter.take("requests")) {
      throw new ToolError("RATE_LIMITED", `tool requests exceeded ${config.requestsPerMinute}/minute`);
    }
    if (bucket === "prompt" && !promptLimiter.take("prompt")) {
      throw new ToolError("RATE_LIMITED", `prompt exceeded ${config.promptPerMinute}/minute`);
    }
  }

  async function listSummaries(signal) {
    const value = await controller().list({}, signal);
    return value.items ?? [];
  }

  /** Require that the Session's recorded cwd stays inside the allowlist. */
  async function requireAllowedSession(sessionId, signal) {
    const items = await listSummaries(signal);
    const summary = items.find((item) => item.sessionId === sessionId);
    if (summary === undefined) throw new ToolError("NOT_FOUND", `session not found: ${sessionId}`);
    if (!pathWithinRoots(summary.cwd, roots)) {
      throw new ToolError("FORBIDDEN_WORKSPACE", `session ${sessionId} is outside the workspace allowlist`);
    }
    const cwd = summary.cwd;
    try {
      return { summary, cwd: await resolveAllowedDir(cwd, roots) };
    } catch {
      throw new ToolError("FORBIDDEN_WORKSPACE", `session ${sessionId} cwd is no longer an allowed directory`);
    }
  }

  async function resolveBaseDirectory(args) {
    const hasSession = args.sessionId !== undefined;
    const hasCwd = args.cwd !== undefined;
    if (hasSession === hasCwd) throw badRequest("provide exactly one of sessionId or cwd");
    if (hasSession) {
      const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
      const allowed = await withSignal(15_000, (signal) => requireAllowedSession(sessionId, signal));
      return allowed.cwd;
    }
    return resolveAllowedDir(requireString(args.cwd, "cwd", { maximum: 4096 }), roots);
  }

  /**
   * Resolve which source tag to record for a newly created Session.
   * An invalid tag fails before any Session is created, so a rejected call
   * never leaves a stray Session behind.
   */
  function readSource(args) {
    try {
      return normalizeSource(args.source);
    } catch (error) {
      if (error instanceof SourceValidationError) throw badRequest(error.message);
      throw error;
    }
  }

  /**
   * Turn the prompt content arguments (`text` + `images`) into Host content
   * blocks. Shared by `dsh_prompt` and `dsh_steer` so both accept exactly the
   * same payload shape.
   */
  function buildPromptContent(args) {
    const text = typeof args.text === "string" ? args.text : "";
    const images = args.images ?? [];
    if (!Array.isArray(images)) throw badRequest("images must be an array");
    if (text.trim().length === 0 && images.length === 0) throw badRequest("text or at least one image is required");
    const content = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const [index, image] of images.entries()) {
      if (image === null || typeof image !== "object") throw badRequest(`images[${index}] must be an object`);
      const mediaType = requireString(image.mediaType, `images[${index}].mediaType`, { maximum: 100 });
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw badRequest(`unsupported image media type: ${mediaType}`);
      const data = requireString(image.data, `images[${index}].data`, { maximum: 64 * 1024 * 1024 });
      const name = optionalString(image.name, `images[${index}].name`, { maximum: 200 });
      content.push({ type: "image", mediaType, data, ...(name === undefined ? {} : { name }) });
    }
    return content;
  }

  /**
   * Refuse steering a Session that is not running.
   *
   * The Host would accept a steer into an idle Agent as a next-step injection,
   * which silently delays the message instead of redirecting a live turn. The
   * friendly BAD_REQUEST keeps a caller from mistaking that for a real steer.
   */
  async function requireRunningSession(sessionId, signal) {
    const state = await controller().state({ sessionId }, signal);
    if (state?.running !== true) {
      throw new ToolError("BAD_REQUEST", "session is not running; use dsh_prompt with delivery=queue instead");
    }
    return state;
  }

  const tools = [
    {
      name: "dsh_list_sessions",
      description:
        "List DSH Web Sessions whose working directory is inside the bridge workspace allowlist. Same sessions the human sees in the DSH sidebar.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Optional absolute directory filter (must be inside the allowlist)." },
          query: { type: "string", description: "Optional literal message-content search (max 500 characters; results are intersected with the allowlisted sessions)." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum rows, default 20." }
        },
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const limit = optionalInteger(args.limit, "limit", 20, 1, 100);
        // The Host's session query rejects queries over 500 UTF-16 units; check it
        // here so callers get BAD_REQUEST with a local reason instead of a Host error.
        const query = optionalString(args.query, "query", { maximum: 500 });
        return withSignal(20_000, async (signal) => {
          const cwdFilter = args.cwd === undefined ? undefined : await resolveAllowedDir(requireString(args.cwd, "cwd", { maximum: 4096 }), roots);
          let allowedIds;
          if (query !== undefined) {
            const search = await controller().search({ query }, signal);
            allowedIds = new Set((search.items ?? []).map((item) => item.sessionId));
          }
          const items = await listSummaries(signal);
          const rows = items
            .filter((item) => item.updatedAt !== undefined)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .filter((item) => pathWithinRoots(item.cwd, roots))
            .filter((item) => cwdFilter === undefined || item.cwd === cwdFilter || isInside(cwdFilter, path.resolve(item.cwd)))
            .filter((item) => allowedIds === undefined || allowedIds.has(item.sessionId))
            .slice(0, limit)
            .map((item) => publicSummary(item, sources));
          return { count: rows.length, items: rows };
        });
      }
    },
    {
      name: "dsh_create_session",
      description:
        "Create a DSH Web Session in an allowlisted working directory. Resolves Host workspaceId (explicit > slug > resolveByPath(cwd)) so the session attaches into the named sidebar group instead of 未分组.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description:
              "Absolute working directory; must be inside the bridge workspace allowlist. Used for allowlist checks and workspace resolution."
          },
          workspaceId: {
            type: "string",
            description:
              "Optional Host workspace id. Must own the same canonical path as cwd; otherwise BAD_REQUEST."
          },
          workspaceSlug: {
            type: "string",
            description:
              "Optional operator-configured workspace alias from workspaceSlugs. Mapped then path-checked against cwd."
          },
          title: { type: "string", description: "Optional session title." },
          model: {
            description: 'Optional model selection: "provider/model" or an object {provider, model, reasoningEffort?}.',
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  provider: { type: "string" },
                  model: { type: "string" },
                  reasoningEffort: { type: "string" }
                },
                required: ["provider", "model"],
                additionalProperties: false
              }
            ]
          },
          preset: { type: "string", description: "Optional agent preset name." },
          source: {
            type: "string",
            description:
              "Optional provenance tag recorded by the bridge for this Session (bridge-local, not the Host origin). Default mcp; max 64 chars of [a-z0-9._-]."
          }
        },
        required: ["cwd"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const source = readSource(args);
        const cwd = await resolveAllowedDir(requireString(args.cwd, "cwd", { maximum: 4096 }), roots);
        const title = optionalString(args.title, "title", { maximum: 200 });
        const preset = optionalString(args.preset, "preset", { maximum: 200 });
        const workspaceIdArg = optionalString(args.workspaceId, "workspaceId", { maximum: 80 });
        const workspaceSlug = optionalString(args.workspaceSlug, "workspaceSlug", { maximum: 80 });
        const model = parseModelSelection(args.model);
        // Host session.create accepts workspaceId XOR cwd; workspaceId triggers attachSession.
        const presetFields = preset === undefined ? {} : { agentPreset: preset };
        const warnings = [];
        const resolved = await resolveWorkspaceForCreate({
          registry: ctx.workspaceRegistry,
          cwd,
          workspaceId: workspaceIdArg,
          workspaceSlug,
          workspaceSlugs: config.workspaceSlugs
        });
        const createRequest = resolved
          ? { workspaceId: resolved.workspaceId, ...presetFields }
          : { cwd, ...presetFields };
        if (!resolved) {
          warnings.push("workspace not resolved; session may appear under 未分组");
        }
        const created = await withSignal(30_000, async () => controller().create(createRequest));
        const recorded = sources.record(created.sessionId, source);
        let acceptedTitle;
        // A caller-supplied title wins; otherwise label the Session so the DSH
        // sidebar shows it is machine-driven and which caller owns it.
        const desiredTitle = title ?? defaultSessionTitle(source, created.sessionId);
        try {
          acceptedTitle = (await controller().rename({ sessionId: created.sessionId, title: desiredTitle })).title;
        } catch (error) {
          warnings.push(`title not applied: ${sanitizeHostError(error).code}`);
        }
        let acceptedModel;
        if (model !== undefined) {
          try {
            acceptedModel = (await controller().selectModel({ sessionId: created.sessionId, ...model })).selected;
          } catch (error) {
            warnings.push(`model not applied: ${sanitizeHostError(error).code}`);
          }
        }
        return {
          sessionId: created.sessionId,
          cwd,
          source: recorded.source,
          ...(resolved === null
            ? {}
            : { workspaceId: resolved.workspaceId, workspaceTitle: resolved.workspaceTitle }),
          ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
          ...(acceptedTitle === undefined ? {} : { title: acceptedTitle }),
          ...(acceptedModel === undefined ? {} : { model: acceptedModel }),
          ...(warnings.length === 0 ? {} : { warnings })
        };
      }
    },
    {
      name: "dsh_prompt",
      description:
        "Send a prompt to a DSH Web Session. The human sees the message and the agent's activity live in the DSH Web UI.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string", description: "Prompt text (required unless images are supplied)." },
          images: {
            type: "array",
            description: "Optional base64 images.",
            items: {
              type: "object",
              properties: {
                mediaType: { type: "string", enum: [...IMAGE_MEDIA_TYPES] },
                data: { type: "string", description: "Base64-encoded image bytes." },
                name: { type: "string" }
              },
              required: ["mediaType", "data"],
              additionalProperties: false
            }
          },
          delivery: { type: "string", enum: ["queue", "steer"], description: "queue starts/queues a turn; steer injects into the running turn. Default queue." }
        },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit("prompt");
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        const content = buildPromptContent(args);
        const delivery = args.delivery === undefined ? "queue" : args.delivery;
        if (delivery !== "queue" && delivery !== "steer") throw badRequest("delivery must be queue or steer");
        const requestId = promptRequestId(randomUUID());
        await withSignal(30_000, async (signal) => {
          await requireAllowedSession(sessionId, signal);
          await controller().prompt({ requestId, sessionId, mode: delivery, content }, signal);
        });
        return {
          requestId,
          sessionId,
          accepted: true,
          delivery,
          source: sources.get(sessionId)?.source ?? "unknown"
        };
      }
    },
    {
      name: "dsh_steer",
      description:
        "Redirect a RUNNING DSH Web Session: inject a message into the turn that is executing right now so the agent changes course without waiting for the next turn. Fails with BAD_REQUEST when the Session is idle; use dsh_prompt in that case.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string", description: "Steering text (required unless images are supplied)." },
          images: {
            type: "array",
            description: "Optional base64 images, same shape as dsh_prompt.",
            items: {
              type: "object",
              properties: {
                mediaType: { type: "string", enum: [...IMAGE_MEDIA_TYPES] },
                data: { type: "string", description: "Base64-encoded image bytes." },
                name: { type: "string" }
              },
              required: ["mediaType", "data"],
              additionalProperties: false
            }
          }
        },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit("prompt");
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        const content = buildPromptContent(args);
        const requestId = steerRequestId(randomUUID());
        await withSignal(30_000, async (signal) => {
          await requireAllowedSession(sessionId, signal);
          let running;
          try {
            running = (await requireRunningSession(sessionId, signal)).running;
          } catch (error) {
            throw sanitizeHostError(error);
          }
          if (running !== true) throw badRequest("session is not running; use dsh_prompt instead");
          try {
            await controller().prompt({ requestId, sessionId, mode: "steer", content }, signal);
          } catch (error) {
            throw sanitizeHostError(error);
          }
        });
        return {
          requestId,
          sessionId,
          accepted: true,
          delivery: "steer",
          source: sources.get(sessionId)?.source ?? "unknown"
        };
      }
    },
    {
      name: "dsh_update_queue",
      description:
        "Mutate one pending queue item of a DSH Web Session: edit its text, remove it, or steer it into the running turn. Read the queue item ids from dsh_get_status first.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string", description: "Queue item id from dsh_get_status queue[].id." },
          action: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["edit", "remove", "steer"] },
              text: { type: "string", description: "Replacement text; required when kind is edit, forbidden otherwise." }
            },
            required: ["kind"],
            additionalProperties: false
          }
        },
        required: ["sessionId", "itemId", "action"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        const itemId = requireString(args.itemId, "itemId", { maximum: 200 });
        let action;
        try {
          action = normalizeQueueAction(args.action);
        } catch (error) {
          if (error instanceof QueueValidationError) throw badRequest(error.message);
          throw error;
        }
        await withSignal(30_000, async (signal) => {
          await requireAllowedSession(sessionId, signal);
          try {
            await controller().updateQueue({ sessionId, itemId, action });
          } catch (error) {
            // Host failure codes are namespaced (session/queue-item-not-found,
            // session/steer-unavailable) and must map onto stable bridge codes.
            const { code, remoteCode } = mapHostError(error);
            const message = error instanceof Error ? error.message : String(error);
            throw new ToolError(code, message.replaceAll("\n", " ").slice(0, 600), { remoteCode });
          }
        });
        return { sessionId, itemId, action: action.kind, accepted: true };
      }
    },
    {
      name: "dsh_cancel",
      description: "Cancel the active turn of a DSH Web Session without dropping its pending inbox.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        return withSignal(15_000, async (signal) => {
          await requireAllowedSession(sessionId, signal);
          // Host `cancel` is synchronous in 0.2.2-rc.3 but may become async; awaiting
          // keeps `accepted` meaningful either way.
          const value = await controller().cancel({ sessionId });
          return { sessionId, accepted: value?.accepted === true };
        });
      }
    },
    {
      name: "dsh_get_status",
      description: "Read the run state of a DSH Web Session: running/active, event cursor, queue depth, and pending input.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        return withSignal(15_000, async (signal) => {
          const { summary } = await requireAllowedSession(sessionId, signal);
          const state = await controller().state({ sessionId }, signal);
          const queue = Array.isArray(state.queue) ? summarizeQueue(state.queue) : [];
          return {
            sessionId,
            cwd: summary.cwd,
            updatedAt: summary.updatedAt,
            running: state.running,
            active: state.active,
            cursor: state.cursor,
            queueLength: state.queue === null ? null : state.queue.length,
            ...(state.queue === null ? {} : { queue }),
            pendingInput: state.pendingInput,
            agentAvailable: summary.agentAvailable,
            blank: summary.blank,
            source: sources.get(sessionId)?.source ?? "unknown"
          };
        });
      }
    },
    {
      name: "dsh_get_projections",
      description: "Read a sequenced projection snapshot for a DSH Web Session, optionally filtered to specific projection keys.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          keys: { type: "array", items: { type: "string" }, description: "Optional projection keys to return." }
        },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        const keys = args.keys === undefined ? undefined : args.keys;
        if (keys !== undefined && (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))) {
          throw badRequest("keys must be an array of strings");
        }
        return withSignal(20_000, async (signal) => {
          await requireAllowedSession(sessionId, signal);
          const value = await controller().projections({ sessionId }, signal);
          if (value === null) return { sessionId, present: false };
          const values = keys === undefined
            ? value.values
            : Object.fromEntries(keys.filter((key) => key in value.values).map((key) => [key, value.values[key]]));
          return { sessionId, present: true, kind: value.kind, ...(value.asOfSeq === undefined ? {} : { asOfSeq: value.asOfSeq }), values };
        });
      }
    },
    {
      name: "dsh_follow",
      description:
        "Follow a DSH Web Session from a sequence cursor and return durable events (including tool calls and results) within a bounded timeout.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          sinceSeq: { type: "integer", minimum: 0, description: "Only return events with seq greater than this cursor." },
          maxEvents: { type: "integer", minimum: 1, maximum: 200, description: "Maximum durable events to collect (default 50)." },
          timeoutMs: { type: "integer", minimum: 500, maximum: 30000, description: "Follow timeout in milliseconds (default 8000)." },
          maxMessages: { type: "integer", minimum: 1, maximum: 500, description: "Optional follow snapshot message budget." }
        },
        required: ["sessionId"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const sessionId = requireString(args.sessionId, "sessionId", { maximum: 200 });
        const sinceSeq = optionalInteger(args.sinceSeq, "sinceSeq", 0, 0, Number.MAX_SAFE_INTEGER);
        const maxEvents = optionalInteger(args.maxEvents, "maxEvents", 50, 1, Math.min(200, config.followMaxEvents));
        const timeoutMs = optionalInteger(args.timeoutMs, "timeoutMs", Math.min(30000, config.followDefaultTimeoutMs), 500, Math.min(30000, config.followMaxTimeoutMs));
        const maxMessages = optionalInteger(args.maxMessages, "maxMessages", undefined, 1, 500);
        const allowed = await withSignal(15_000, (signal) => requireAllowedSession(sessionId, signal));
        void allowed;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        timer.unref?.();
        const records = [];
        const result = { sessionId, cursor: null, header: null, projections: null, hasMore: null, records, truncated: false, timedOut: false };
        const push = (record) => {
          const event = record?.event;
          if (event === undefined || typeof event.seq !== "number" || event.seq <= sinceSeq) return;
          if (records.length >= maxEvents) return;
          records.push({ seq: event.seq, type: event.type, time: event.time, data: event.data });
        };
        const stream = controller().follow({ address: { kind: "session", sessionId }, ...(maxMessages === undefined ? {} : { maxMessages }) }, abort.signal);
        const iterator = stream[Symbol.asyncIterator]();
        try {
          while (records.length < maxEvents) {
            const step = await iterator.next();
            if (step.done) break;
            const frame = step.value;
            if (frame.type === "snapshot") {
              result.cursor = frame.cursor;
              result.header = frame.header;
              result.projections = frame.projections;
              result.hasMore = frame.hasMore;
              for (const record of frame.records ?? []) push(record);
            } else if (frame.type === "event") {
              push(frame);
            }
          }
          if (records.length >= maxEvents) result.truncated = true;
        } catch (error) {
          if (abort.signal.aborted) result.timedOut = true;
          else throw sanitizeHostError(error);
        } finally {
          clearTimeout(timer);
          try {
            await iterator.return?.();
          } catch {
            /* stream already closed */
          }
          abort.abort();
        }
        return result;
      }
    },
    {
      name: "dsh_read_workspace_file",
      description:
        "Read a text/binary file (for example a RESULT.md) using a path relative to the session cwd. Absolute paths and traversal outside the session cwd are rejected.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session whose cwd is the base directory." },
          cwd: { type: "string", description: "Explicit absolute base directory (alternative to sessionId)." },
          path: { type: "string", description: "Path relative to the base directory." },
          maxBytes: { type: "integer", minimum: 1, maximum: 8388608, description: "Maximum bytes to read, default 262144." }
        },
        required: ["path"],
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const rawPath = requireString(args.path, "path", { maximum: 4096 });
        if (path.isAbsolute(rawPath) || rawPath.includes("\0")) throw badRequest("path must be relative");
        const maxBytes = optionalInteger(args.maxBytes, "maxBytes", config.readFileMaxBytes, 1, 8 * 1024 * 1024);
        const base = await resolveBaseDirectory(args);
        const target = path.resolve(base, rawPath);
        if (!isInside(base, target)) throw new ToolError("FORBIDDEN_WORKSPACE", "path escapes the session working directory");
        let real;
        try {
          real = await realpath(target);
        } catch {
          throw new ToolError("NOT_FOUND", `file not found: ${rawPath}`);
        }
        if (!isInside(base, real)) throw new ToolError("FORBIDDEN_WORKSPACE", "resolved path escapes the session working directory");
        const info = await stat(real);
        if (!info.isFile()) throw badRequest(`not a regular file: ${rawPath}`);
        const length = Math.min(info.size, maxBytes);
        const buffer = Buffer.alloc(length);
        if (length > 0) {
          const handle = await open(real, "r");
          try {
            await handle.read(buffer, 0, length, 0);
          } finally {
            await handle.close();
          }
        }
        const binary = buffer.subarray(0, Math.min(length, 8192)).includes(0);
        return {
          path: path.relative(base, real).split(path.sep).join("/"),
          bytes: length,
          size: info.size,
          truncated: info.size > length,
          encoding: binary ? "base64" : "utf8",
          content: binary ? buffer.toString("base64") : buffer.toString("utf8")
        };
      }
    },
    {
      name: "dsh_list_artifacts",
      description:
        "List deliverable/result files under the session cwd, filtered by glob patterns (default: RESULT/markdown/json files).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          cwd: { type: "string" },
          glob: {
            description: "Glob pattern (or array of patterns) relative to the base directory, supporting *, ? and **.",
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ]
          }
        },
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const base = await resolveBaseDirectory(args);
        const rawPatterns = args.glob === undefined
          ? ["**/RESULT*.md", "*.md", "**/*-RESULT.md", "*.json"]
          : Array.isArray(args.glob)
            ? args.glob
            : [args.glob];
        if (rawPatterns.length === 0 || rawPatterns.length > 16) throw badRequest("glob must contain 1 to 16 patterns");
        const compiled = rawPatterns.map((pattern) => globToRegExp(requireString(pattern, "glob", { maximum: 500 })));
        const items = await collectArtifacts(base, compiled, { maxDepth: config.artifactsMaxDepth, limit: config.artifactsLimit });
        return { cwd: base, count: items.length, items };
      }
    },
    {
      name: "dsh_list_workspaces",
      description:
        "List Host workspaces whose path is inside the bridge allowlist (sidebar tree JSON; read-only).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Optional: only return the workspace that owns this allowlisted path."
          },
          includeSessionIds: {
            type: "boolean",
            description: "When true, include sessionIds (may be long). Default false."
          },
          sessionIdLimit: {
            type: "integer",
            description: "Max sessionIds to return per workspace when includeSessionIds is true. Default 50, max 500."
          }
        },
        additionalProperties: false
      },
      async handler(args) {
        takeLimit();
        const includeSessionIds = optionalBoolean(args.includeSessionIds, "includeSessionIds") === true;
        const sessionIdLimit = optionalInteger(args.sessionIdLimit, "sessionIdLimit", 50, 1, 500);
        let cwdFilter;
        if (args.cwd !== undefined) {
          cwdFilter = await resolveAllowedDir(requireString(args.cwd, "cwd", { maximum: 4096 }), roots);
        }
        const registry = ctx.workspaceRegistry;
        if (!registry || typeof registry.list !== "function") {
          return { count: 0, items: [], warning: "workspaceRegistry unavailable" };
        }
        const items = [];
        for (const ws of registry.list() || []) {
          if (!ws || !ws.path) continue;
          if (!pathWithinRoots(ws.path, roots)) continue;
          if (cwdFilter !== undefined) {
            const same = ws.path === cwdFilter || (await pathsEqual(ws.path, cwdFilter));
            if (!same) continue;
          }
          const row = {
            id: String(ws.id),
            title: ws.title,
            path: ws.path
          };
          if (includeSessionIds) {
            const ids = [...(ws.sessionIds || [])].map(String);
            row.sessionIdCount = ids.length;
            row.sessionIds = ids.slice(0, sessionIdLimit);
            row.sessionIdsTruncated = ids.length > sessionIdLimit;
          } else {
            row.sessionIdCount = Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0;
          }
          items.push(row);
        }
        return { count: items.length, items };
      }
    }
  ];

  return { tools, promptLimiter, requestLimiter, sources };
}
