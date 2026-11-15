/**
 * Pure helpers for the P3b queue-mutation and steering tools.
 *
 * Everything here is intentionally Host-free: the shapes mirror the Session
 * Controller contract (`QueueAction`, `SessionQueuedItem`) so the validation
 * and error mapping can be unit-tested without booting a Host.
 */

/** Queue actions the bridge forwards to `SessionController.updateQueue`. */
export const QUEUE_ACTION_KINDS = ["edit", "remove", "steer"];

/** Maximum characters of a queue item's text returned by `dsh_get_status`. */
export const TEXT_PREVIEW_LIMIT = 200;

export class QueueValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueValidationError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Translate the bridge's flat `action` argument into the Host `QueueAction`
 * union.
 *
 * Flat input keeps the MCP schema simple (`kind` + optional `text`), while the
 * Host wants a discriminated union with typed `TextBlock` content for edits.
 *
 * @param action - caller-supplied `{kind, text?}` object.
 * @returns Host `QueueAction`.
 */
export function normalizeQueueAction(action) {
  if (!isPlainObject(action)) throw new QueueValidationError("action must be an object");
  for (const key of Object.keys(action)) {
    if (key !== "kind" && key !== "text") throw new QueueValidationError(`unknown action field: ${key}`);
  }
  const kind = action.kind;
  if (typeof kind !== "string" || !QUEUE_ACTION_KINDS.includes(kind)) {
    throw new QueueValidationError(`action.kind must be one of ${QUEUE_ACTION_KINDS.join(", ")}`);
  }
  if (kind === "edit") {
    const text = action.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new QueueValidationError("action.text must be a non-empty string when action.kind is edit");
    }
    return { kind: "edit", content: [{ type: "text", text }] };
  }
  if (action.text !== undefined) {
    throw new QueueValidationError(`action.text is only valid when action.kind is edit`);
  }
  return { kind };
}

/**
 * Extract the first text block of one pending queue item and truncate it.
 *
 * @param item - `SessionQueuedItem` from `state().queue`.
 * @returns preview string, or undefined when the item carries no text.
 */
export function queueItemTextPreview(item) {
  const content = item?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const collapsed = block.text.replaceAll(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    return collapsed.length > TEXT_PREVIEW_LIMIT ? `${collapsed.slice(0, TEXT_PREVIEW_LIMIT)}…` : collapsed;
  }
  return undefined;
}

/**
 * Project the Host queue into the compact rows `dsh_get_status` returns.
 * The row ids are exactly what `dsh_update_queue` accepts, so a client can
 * read the status and mutate a specific pending item in two calls.
 */
export function summarizeQueue(queue) {
  if (!Array.isArray(queue)) return [];
  const rows = [];
  for (const item of queue) {
    if (!isPlainObject(item) || typeof item.id !== "string") continue;
    const textPreview = queueItemTextPreview(item);
    rows.push({
      id: item.id,
      placement: item.placement,
      ...(typeof item.rpcId === "string" ? { rpcId: item.rpcId } : {}),
      ...(textPreview === undefined ? {} : { textPreview })
    });
  }
  return rows;
}

const ERROR_CODE_SUFFIXES = [
  ["session/steer-unavailable", "BAD_REQUEST"],
  ["session/queue-item-not-found", "BAD_REQUEST"],
  ["session/not-found", "NOT_FOUND"],
  ["gateway/not-found", "NOT_FOUND"],
  ["session/attachment-invalid", "BAD_REQUEST"],
  ["gateway/bad-request", "BAD_REQUEST"]
];

/**
 * Map a Host failure onto one of the bridge's stable error codes.
 *
 * Host codes are namespaced (`session/queue-item-not-found`) and the transport
 * may wrap them, so matching is by suffix rather than equality. Anything
 * unrecognized falls through as HOST_ERROR and is never echoed verbatim.
 *
 * @param error - caught Host failure (RemoteError or plain Error).
 * @returns `{code, remoteCode}`.
 */
export function mapHostError(error) {
  const remoteCode = typeof error?.code === "string" ? error.code : typeof error?.name === "string" ? error.name : undefined;
  if (remoteCode === undefined) return { code: "HOST_ERROR" };
  const matched = ERROR_CODE_SUFFIXES.find(([suffix]) => remoteCode === suffix || remoteCode.endsWith(suffix));
  if (matched !== undefined) return { code: matched[1], remoteCode };
  if (remoteCode.includes("not-found")) return { code: "NOT_FOUND", remoteCode };
  if (remoteCode.includes("bad-request") || remoteCode.includes("unavailable") || remoteCode.includes("invalid")) {
    return { code: "BAD_REQUEST", remoteCode };
  }
  return { code: "HOST_ERROR", remoteCode };
}

/** Stable request-id prefix for `dsh_prompt` deliveries. */
export const PROMPT_REQUEST_PREFIX = "mcp-";

/** Stable request-id prefix for `dsh_steer` deliveries. */
export const STEER_REQUEST_PREFIX = "mcp-steer-";

export function promptRequestId(uuid) {
  return `${PROMPT_REQUEST_PREFIX}${uuid}`;
}

export function steerRequestId(uuid) {
  return `${STEER_REQUEST_PREFIX}${uuid}`;
}
