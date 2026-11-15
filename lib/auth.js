import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

/** Constant-time string comparison over fixed-size digests. */
export function safeEqualSecret(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length === 0 || provided.length === 0) return false;
  return timingSafeEqual(sha256(expected), sha256(provided));
}

/** Extract a bearer token from an Authorization-style header value. */
export function parseBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match === null ? null : match[1];
}

function normalizeSecret(text, minimum) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < minimum) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/** Read the secret once at startup; returns null when missing, empty, or too short. */
export function loadSecretFileSync(file, minimum) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    return normalizeSecret(readFileSync(file, "utf8"), minimum);
  } catch {
    return null;
  }
}

/**
 * Read the secret on every request so rotation (including same-millisecond
 * rewrites) takes effect immediately. A missing or invalid file makes `get()`
 * return null, which callers treat as an authentication failure.
 */
export class SecretStore {
  constructor(file, minimum) {
    this.file = file;
    this.minimum = minimum;
  }

  async get() {
    try {
      const info = await stat(this.file);
      if (!info.isFile()) return null;
      return normalizeSecret(await readFile(this.file, "utf8"), this.minimum);
    } catch {
      return null;
    }
  }
}
