import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** True when `target` is `root` itself or a descendant of it. */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve configured allowlist roots to canonical real paths. A root that
 * cannot be resolved is dropped; callers must fail closed when none remain.
 */
export async function canonicalizeRoots(configured) {
  const roots = [];
  const dropped = [];
  for (const entry of configured) {
    try {
      const real = await realpath(entry);
      if (!(await stat(real)).isDirectory()) {
        dropped.push({ entry, reason: "not a directory" });
        continue;
      }
      if (!roots.includes(real)) roots.push(real);
    } catch (error) {
      dropped.push({ entry, reason: error?.code ?? String(error) });
    }
  }
  return { roots, dropped };
}

/** Resolve one directory and require it to fall inside an allowlist root. */
export async function resolveAllowedDir(directory, roots) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw Object.assign(new Error("directory path is required"), { code: "BAD_REQUEST" });
  }
  if (!path.isAbsolute(directory)) {
    throw Object.assign(new Error(`directory must be absolute: ${JSON.stringify(directory)}`), { code: "BAD_REQUEST" });
  }
  let real;
  try {
    real = await realpath(directory);
  } catch {
    throw Object.assign(new Error(`directory does not exist: ${JSON.stringify(directory)}`), { code: "NOT_FOUND" });
  }
  if (!(await stat(real)).isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${JSON.stringify(directory)}`), { code: "BAD_REQUEST" });
  }
  if (!roots.some((root) => isInside(root, real))) {
    throw Object.assign(new Error(`directory is outside the workspace allowlist: ${JSON.stringify(real)}`), {
      code: "FORBIDDEN_WORKSPACE"
    });
  }
  return real;
}

/** Loose containment check for values already recorded by the host (no fs access). */
export function pathWithinRoots(candidate, roots) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (!path.isAbsolute(candidate)) return false;
  const normalized = path.resolve(candidate);
  return roots.some((root) => isInside(root, normalized));
}

/** Convert a posix glob (`*`, `?`, `**`) to an anchored RegExp. */
export function globToRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw Object.assign(new Error("glob pattern must be a non-empty string"), { code: "BAD_REQUEST" });
  }
  const anchored = pattern.includes("/") ? pattern : `**/${pattern}`;
  let source = "";
  for (let index = 0; index < anchored.length; index += 1) {
    const character = anchored[index];
    if (character === "*") {
      if (anchored[index + 1] === "*") {
        if (anchored[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAnyGlob(patterns, relativePath) {
  return patterns.some((regex) => regex.test(relativePath));
}

/**
 * Collect regular files under `root` that match the compiled glob patterns.
 * Symlinks are skipped, dot directories and node_modules/.git are pruned, and
 * traversal is bounded by depth and result count.
 */
export async function collectArtifacts(root, patterns, options) {
  const { maxDepth, limit } = options;
  const results = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length > 0 && results.length < limit) {
    const current = pending.shift();
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (name.startsWith(".") || name === "node_modules") continue;
        if (current.depth + 1 > maxDepth) continue;
        pending.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!matchesAnyGlob(patterns, relative)) continue;
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      results.push({ path: relative, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return results;
}
