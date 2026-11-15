import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSecretFileSync, parseBearer, safeEqualSecret, SecretStore } from "../lib/auth.js";
import { isLoopbackHost, normalizeConfig } from "../lib/config.js";
import { collectArtifacts, globToRegExp, isInside, matchesAnyGlob } from "../lib/paths.js";
import {
  mapHostError,
  normalizeQueueAction,
  promptRequestId,
  queueItemTextPreview,
  QueueValidationError,
  steerRequestId,
  summarizeQueue,
  TEXT_PREVIEW_LIMIT
} from "../lib/queue.js";
import { SlidingWindow } from "../lib/rate-limit.js";
import { defaultSessionTitle, normalizeSource, SourceRegistry, SourceValidationError } from "../lib/source.js";
import { createTools, resolveWorkspaceForCreate } from "../lib/tools.js";

test("isLoopbackHost accepts only loopback literals", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.9.9.9"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), false);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.0.2.1"), false);
  assert.equal(isLoopbackHost(""), false);
});

test("normalizeConfig applies defaults and rejects unsafe values", () => {
  assert.throws(() => normalizeConfig(undefined), /workspaceAllowlist/);
  assert.throws(() => normalizeConfig({}), /workspaceAllowlist/);
  const config = normalizeConfig({ workspaceAllowlist: ["/home/dsops/projects/your-project"] });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 17300);
  assert.equal(config.path, "/mcp");
  assert.deepEqual(config.workspaceAllowlist, ["/home/dsops/projects/your-project"]);

  assert.throws(() => normalizeConfig({ host: "0.0.0.0" }), /loopback/);
  assert.throws(() => normalizeConfig({ host: "localhost" }), /loopback/);
  assert.throws(() => normalizeConfig({ port: 0, workspaceAllowlist: ["/tmp"] }), /port/);
  assert.throws(() => normalizeConfig({ workspaceAllowlist: ["relative/path"] }), /absolute/);
  assert.throws(() => normalizeConfig({ workspaceAllowlist: [] }), /non-empty/);
  assert.throws(() => normalizeConfig({ surprise: true }), /unknown config field/);
});

test("bearer parsing and constant-time secret comparison", () => {
  assert.equal(parseBearer("Bearer abc123"), "abc123");
  assert.equal(parseBearer("bearer  abc123 "), "abc123");
  assert.equal(parseBearer("Basic abc123"), null);
  assert.equal(parseBearer(undefined), null);
  assert.equal(safeEqualSecret("secret-value", "secret-value"), true);
  assert.equal(safeEqualSecret("secret-value", "secret-valuf"), false);
  assert.equal(safeEqualSecret("secret-value", ""), false);
});

test("secret file loader fails closed on missing, empty, or short files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-auth-"));
  const missing = path.join(directory, "missing.fixture");
  const empty = path.join(directory, "empty.fixture");
  const short = path.join(directory, "short.fixture");
  const good = path.join(directory, "good.fixture");
  await writeFile(empty, "\n");
  await writeFile(short, "tiny");
  await writeFile(good, "0123456789abcdef0123456789abcdef\n");
  assert.equal(loadSecretFileSync(missing, 16), null);
  assert.equal(loadSecretFileSync(empty, 16), null);
  assert.equal(loadSecretFileSync(short, 16), null);
  assert.equal(loadSecretFileSync(good, 16), "0123456789abcdef0123456789abcdef");
  const store = new SecretStore(good, 16);
  assert.equal(await store.get(), "0123456789abcdef0123456789abcdef");
  await writeFile(good, "rotated-secret-value-0123456789\n");
  assert.equal(await store.get(), "rotated-secret-value-0123456789");
});

test("isInside rejects parents, siblings, and absolute paths", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
});

test("glob translation supports *, ?, ** and basename-only patterns", () => {
  assert.equal(matchesAnyGlob([globToRegExp("**/RESULT*.md")], "RESULT.md"), true);
  assert.equal(matchesAnyGlob([globToRegExp("**/RESULT*.md")], "work/p3a/RESULT-x.md"), true);
  assert.equal(matchesAnyGlob([globToRegExp("**/RESULT*.md")], "work/RESULT.txt"), false);
  assert.equal(matchesAnyGlob([globToRegExp("*.json")], "a/b/file.json"), true);
  assert.equal(matchesAnyGlob([globToRegExp("a/*/c.md")], "a/b/c.md"), true);
  assert.equal(matchesAnyGlob([globToRegExp("a/*/c.md")], "a/b/d/c.md"), false);
  assert.equal(matchesAnyGlob([globToRegExp("file?.md")], "file1.md"), true);
});

test("collectArtifacts prunes node_modules and honors depth and limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-artifacts-"));
  await mkdir(path.join(root, "work", "deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "RESULT.md"), "top");
  await writeFile(path.join(root, "work", "deep", "RESULT-x.md"), "deep");
  await writeFile(path.join(root, "node_modules", "pkg", "RESULT-hidden.md"), "hidden");
  const patterns = [globToRegExp("**/RESULT*.md")];
  const items = await collectArtifacts(root, patterns, { maxDepth: 5, limit: 10 });
  const paths = items.map((item) => item.path).sort();
  assert.deepEqual(paths, ["RESULT.md", "work/deep/RESULT-x.md"]);
  const shallow = await collectArtifacts(root, patterns, { maxDepth: 1, limit: 10 });
  assert.deepEqual(shallow.map((item) => item.path), ["RESULT.md"]);
});

test("SlidingWindow enforces its limit inside the window", () => {
  const window = new SlidingWindow(3, 1000);
  assert.equal(window.take("a", 0), true);
  assert.equal(window.take("a", 1), true);
  assert.equal(window.take("a", 2), true);
  assert.equal(window.take("a", 3), false);
  assert.equal(window.take("a", 2000), true);
  assert.equal(window.take("b", 2000), true);
  window.prune(5000);
  assert.equal(window.hits.size, 0);
});

test("normalizeSource defaults to mcp and rejects unsafe tags", () => {
  assert.equal(normalizeSource(undefined), "mcp");
  assert.equal(normalizeSource("mcp"), "mcp");
  assert.equal(normalizeSource("jav-bot.v2_test"), "jav-bot.v2_test");
  assert.equal(normalizeSource("a".repeat(64)), "a".repeat(64));
  assert.throws(() => normalizeSource("a".repeat(65)), SourceValidationError);
  assert.throws(() => normalizeSource(""), SourceValidationError);
  assert.throws(() => normalizeSource("Jav Bot"), SourceValidationError);
  assert.throws(() => normalizeSource("jav/bot"), SourceValidationError);
  assert.throws(() => normalizeSource("[mcp]"), SourceValidationError);
  assert.throws(() => normalizeSource(42), SourceValidationError);
});

test("defaultSessionTitle carries the source tag and a short id tail", () => {
  assert.equal(defaultSessionTitle("mcp", "session-0123456789abcdef"), "[mcp] 89abcdef");
  assert.equal(defaultSessionTitle("grok-bot", "abc"), "[grok-bot] abc");
  assert.equal(defaultSessionTitle("mcp", undefined), "[mcp] unknown");
});

test("SourceRegistry records, overwrites, and evicts oldest entries", () => {
  const registry = new SourceRegistry(2);
  assert.equal(registry.get("s1"), undefined);
  const first = registry.record("s1", "mcp");
  assert.equal(first.source, "mcp");
  assert.equal(registry.get("s1").source, "mcp");
  registry.record("s2", "grok");
  assert.equal(registry.size, 2);
  registry.record("s3", "jav");
  assert.equal(registry.size, 2);
  assert.equal(registry.get("s1"), undefined);
  assert.equal(registry.get("s3").source, "jav");
  const createdAt = registry.get("s3").createdAt;
  assert.equal(registry.record("s3", "other").createdAt, createdAt);
});

test("normalizeQueueAction builds Host QueueAction shapes", () => {
  assert.deepEqual(normalizeQueueAction({ kind: "edit", text: "新方向" }), {
    kind: "edit",
    content: [{ type: "text", text: "新方向" }]
  });
  assert.deepEqual(normalizeQueueAction({ kind: "remove" }), { kind: "remove" });
  assert.deepEqual(normalizeQueueAction({ kind: "steer" }), { kind: "steer" });
  assert.throws(() => normalizeQueueAction({ kind: "edit" }), QueueValidationError);
  assert.throws(() => normalizeQueueAction({ kind: "edit", text: "   " }), QueueValidationError);
  assert.throws(() => normalizeQueueAction({ kind: "edit", text: 42 }), QueueValidationError);
  assert.throws(() => normalizeQueueAction({ kind: "remove", text: "ignored" }), QueueValidationError);
  assert.throws(() => normalizeQueueAction({ kind: "delete" }), QueueValidationError);
  assert.throws(() => normalizeQueueAction({}), QueueValidationError);
  assert.throws(() => normalizeQueueAction(null), QueueValidationError);
  assert.throws(() => normalizeQueueAction([]), QueueValidationError);
  assert.throws(() => normalizeQueueAction({ kind: "remove", extra: 1 }), QueueValidationError);
});

test("queueItemTextPreview collapses whitespace and truncates", () => {
  assert.equal(queueItemTextPreview({ content: [{ type: "text", text: "  hello\n  world  " }] }), "hello world");
  assert.equal(queueItemTextPreview({ content: [{ type: "image", mediaType: "image/png", data: "x" }] }), undefined);
  assert.equal(queueItemTextPreview({ content: [] }), undefined);
  assert.equal(queueItemTextPreview({}), undefined);
  const long = queueItemTextPreview({ content: [{ type: "text", text: "x".repeat(500) }] });
  assert.equal(long.length, TEXT_PREVIEW_LIMIT + 1);
  assert.equal(long.endsWith("…"), true);
});

test("summarizeQueue projects status rows and skips malformed items", () => {
  const rows = summarizeQueue([
    { id: "m1", placement: "queued", rpcId: "mcp-1", content: [{ type: "text", text: "first" }] },
    { id: "m2", placement: "steering", content: [{ type: "image", mediaType: "image/png", data: "x" }] },
    { placement: "queued", content: [] },
    null
  ]);
  assert.deepEqual(rows, [
    { id: "m1", placement: "queued", rpcId: "mcp-1", textPreview: "first" },
    { id: "m2", placement: "steering" }
  ]);
  assert.deepEqual(summarizeQueue(null), []);
});

test("mapHostError maps namespaced Host codes onto stable bridge codes", () => {
  assert.deepEqual(mapHostError({ code: "session/queue-item-not-found" }), {
    code: "BAD_REQUEST",
    remoteCode: "session/queue-item-not-found"
  });
  assert.deepEqual(mapHostError({ code: "session/steer-unavailable" }), {
    code: "BAD_REQUEST",
    remoteCode: "session/steer-unavailable"
  });
  assert.equal(mapHostError({ code: "session/not-found" }).code, "NOT_FOUND");
  assert.equal(mapHostError({ code: "session/attachment-invalid" }).code, "BAD_REQUEST");
  assert.equal(mapHostError({ code: "gateway/bad-request" }).code, "BAD_REQUEST");
  assert.equal(mapHostError(new Error("boom")).code, "HOST_ERROR");
  assert.equal(mapHostError(undefined).code, "HOST_ERROR");
});

test("request id prefixes are stable for prompt and steer", () => {
  assert.equal(promptRequestId("abc"), "mcp-abc");
  assert.equal(steerRequestId("abc"), "mcp-steer-abc");
  assert.equal(steerRequestId("abc").startsWith("mcp-"), true);
  assert.notEqual(steerRequestId("abc"), promptRequestId("abc"));
});

test("dsh_steer rejects a payload without text or images", async () => {
  const { tools } = createToolsForTest();
  const steer = tools.find((tool) => tool.name === "dsh_steer");
  assert.ok(steer !== undefined, "dsh_steer must be registered");
  await assert.rejects(steer.handler({ sessionId: "session-1" }), /text or at least one image is required/);
  await assert.rejects(steer.handler({ sessionId: "session-1", text: "   " }), /text or at least one image is required/);
  await assert.rejects(steer.handler({ sessionId: "session-1", text: "go", images: [{ mediaType: "image/tiff", data: "x" }] }), /unsupported image media type/);
  await assert.rejects(steer.handler({ text: "go" }), /sessionId must be a non-empty string/);
});

test("bridge exposes 12 tools including steer and update_queue", () => {
  const { tools } = createToolsForTest();
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, 12);
  assert.deepEqual(names.slice(0, 4), ["dsh_list_sessions", "dsh_create_session", "dsh_prompt", "dsh_steer"]);
  assert.equal(names.includes("dsh_update_queue"), true);
  assert.ok(names.includes("dsh_list_workspaces"));
});

/** Minimal Host-free factory: only the config values the tools read at build time. */
function createToolsForTest() {
  return createTools({
    ctx: { sessionController: {} },
    config: {
      promptPerMinute: 30,
      requestsPerMinute: 240,
      followDefaultTimeoutMs: 8000,
      followMaxTimeoutMs: 30000,
      followMaxEvents: 200,
      readFileMaxBytes: 262144,
      artifactsLimit: 200,
      artifactsMaxDepth: 5
    },
    roots: ["/tmp"]
  });
}

test("workspaceSlugs validates shape, strings, paths, unknown fields and defaults", () => {
  const base = { workspaceAllowlist: ["/tmp"] };
  assert.deepEqual(normalizeConfig(base).workspaceSlugs, {});
  const entry = { id: "workspace-fixture", path: "/tmp/project", title: "Example" };
  assert.deepEqual(normalizeConfig({ ...base, workspaceSlugs: { demo: entry } }).workspaceSlugs.demo, entry);
  for (const value of [null, [], "bad", { demo: {} }, { demo: { ...entry, path: "relative" } }, { demo: { ...entry, id: "" } }, { demo: { ...entry, title: 1 } }, { demo: { ...entry, extra: true } }, { "": entry }]) {
    assert.throws(() => normalizeConfig({ ...base, workspaceSlugs: value }), /workspaceSlugs/);
  }
});

const wsFixture = { id: "workspace-fixture", title: "Example", path: "/tmp/project" };
const expectedWs = { workspaceId: wsFixture.id, workspaceTitle: wsFixture.title, path: wsFixture.path };
const isBadRequest = (error) => error.code === "BAD_REQUEST";

test("workspace explicit id wins and canonical cwd must agree", async () => {
  const registry = { get: () => wsFixture, resolveByPath: () => { throw Error("must not call"); } };
  assert.deepEqual(await resolveWorkspaceForCreate({ registry, cwd: "/tmp/project/.", workspaceId: wsFixture.id }), expectedWs);
  await assert.rejects(resolveWorkspaceForCreate({ registry, cwd: "/tmp/other", workspaceId: wsFixture.id }), isBadRequest);
  await assert.rejects(resolveWorkspaceForCreate({ registry: { get: () => null }, cwd: wsFixture.path, workspaceId: "missing" }), isBadRequest);
  await assert.rejects(resolveWorkspaceForCreate({ registry: {}, cwd: wsFixture.path, workspaceId: wsFixture.id }), isBadRequest);
});

test("workspace configured slug resolves from registry or configured mapping", async () => {
  const args = { cwd: wsFixture.path, workspaceSlug: "demo", workspaceSlugs: { demo: wsFixture } };
  assert.deepEqual(await resolveWorkspaceForCreate({ ...args, registry: { get: () => wsFixture } }), expectedWs);
  assert.deepEqual(await resolveWorkspaceForCreate({ ...args, registry: {} }), expectedWs);
  await assert.rejects(resolveWorkspaceForCreate({ ...args, cwd: "/tmp/other", registry: {} }), isBadRequest);
  await assert.rejects(resolveWorkspaceForCreate({ ...args, registry: { get: () => ({ ...wsFixture, path: "/tmp/other" }) } }), isBadRequest);
});

test("workspace cwd resolveByPath then list fallback", async () => {
  assert.deepEqual(await resolveWorkspaceForCreate({ cwd: wsFixture.path, registry: { resolveByPath: async () => wsFixture } }), expectedWs);
  assert.deepEqual(await resolveWorkspaceForCreate({ cwd: wsFixture.path, registry: { resolveByPath: async () => { throw Error("missing"); }, list: () => [null, wsFixture] } }), expectedWs);
  assert.deepEqual(await resolveWorkspaceForCreate({ cwd: "/tmp/project/.", registry: { list: () => [wsFixture] } }), expectedWs);
});

test("workspace missing registry/unresolved returns null; unknown slug refuses", async () => {
  assert.equal(await resolveWorkspaceForCreate({ cwd: wsFixture.path }), null);
  assert.equal(await resolveWorkspaceForCreate({ cwd: wsFixture.path, registry: {} }), null);
  await assert.rejects(resolveWorkspaceForCreate({ cwd: wsFixture.path, registry: {}, workspaceSlug: "unknown" }), isBadRequest);
  await assert.rejects(resolveWorkspaceForCreate({ cwd: wsFixture.path, registry: {}, workspaceSlug: "toString" }), isBadRequest);
});

test("create session sends workspaceId XOR cwd and passes configured slugs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-create-"));
  const ws = { id: "workspace-fixture", title: "Demo", path: cwd };
  const sent = [];
  const ctx = { workspaceRegistry: { get: () => ws }, sessionController: {
    create: async (request) => { sent.push(request); return { sessionId: "session-fixture" }; },
    rename: async ({ title }) => ({ title })
  } };
  const config = normalizeConfig({ workspaceAllowlist: [cwd], workspaceSlugs: { demo: ws } });
  const tools = createTools({ ctx, config, roots: [cwd] }).tools;
  const create = tools.find(t => t.name === "dsh_create_session");
  const result = await create.handler({ cwd, workspaceSlug: "demo" });
  assert.deepEqual(sent[0], { workspaceId: ws.id });
  assert.equal(result.workspaceId, ws.id);
  await assert.rejects(create.handler({ cwd, workspaceId: "workspace-fixture", workspaceSlug: "unknown" }), isBadRequest);
  ctx.workspaceRegistry = undefined;
  const fallback = await create.handler({ cwd });
  assert.deepEqual(sent[1], { cwd });
  assert.ok(fallback.warnings.length);
});

test("list_workspaces filters allowlist and handles unavailable registry", async () => {
  const config = normalizeConfig({ workspaceAllowlist: ["/tmp/project"] });
  const ctx = { sessionController: {}, workspaceRegistry: { list: () => [
    { ...wsFixture, sessionIds: ["session-fixture-a", "session-fixture-b"] },
    { id: "outside", path: "/var/private", title: "Outside" }
  ] } };
  const tool = createTools({ ctx, config, roots: ["/tmp/project"] }).tools.find(t => t.name === "dsh_list_workspaces");
  const result = await tool.handler({ includeSessionIds: true, sessionIdLimit: 1 });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].sessionIds.length, 1);
  assert.equal(result.items[0].sessionIdsTruncated, true);
  ctx.workspaceRegistry = undefined;
  assert.equal((await tool.handler({})).count, 0);
});

test("published tool schemas match source exactly", async () => {
  const { readFile } = await import("node:fs/promises");
  const expected = JSON.parse(await readFile(new URL("../docs/tool-schemas.json", import.meta.url), "utf8"));
  const actual = createToolsForTest().tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  assert.deepEqual(actual, expected);
});

test("follow caps snapshot batches and rejects values beyond public schema", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-follow-"));
  const config = normalizeConfig({ workspaceAllowlist: [cwd], followMaxEvents: 2000, followMaxTimeoutMs: 300000 });
  const ctx = { sessionController: {
    list: async () => ({ items: [{ sessionId: "session-fixture", cwd }] }),
    async *follow() { yield { type: "snapshot", cursor: 1000, records: Array.from({length: 300}, (_, i) => ({event:{seq:i+1,type:"fixture"}})) }; }
  } };
  const tool = createTools({ ctx, config, roots: [cwd] }).tools.find(t => t.name === "dsh_follow");
  assert.equal((await tool.handler({ sessionId: "session-fixture", maxEvents: 3 })).records.length, 3);
  await assert.rejects(tool.handler({sessionId:"session-fixture",maxEvents:201}), isBadRequest);
  await assert.rejects(tool.handler({sessionId:"session-fixture",timeoutMs:30001}), isBadRequest);
});

test("local HTTP carrier checks auth, Origin, protocol and client verification scripts", async () => {
  const { createMcpServer } = await import("../lib/mcp.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const config = { ...normalizeConfig({ workspaceAllowlist: ["/tmp"] }), port: 0 };
  // Synthetic in-memory credential, never loaded from any real credential file.
  const synthetic = "unit-test-fixture-".repeat(4);
  const bridge = createMcpServer({ config, secretStore: { get: async () => synthetic }, tools: createToolsForTest().tools, logger: { info(){}, warn(){} } });
  const { url } = await bridge.start();
  try {
    const payload = {jsonrpc:"2.0", id:1, method:"tools/list"};
    const request = (headers) => fetch(url, {method:"POST", headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(payload)});
    assert.equal((await request({})).status, 401);
    assert.equal((await request({Origin:"https://untrusted.example.com"})).status, 403);
    assert.equal((await request({Authorization:"Bearer wrong-fixture"})).status, 401);
    const response = await request({Authorization:"Bearer "+synthetic});
    assert.equal((await response.json()).result.tools.length, 12);
    const { stdout } = await exec("bash", [new URL("../scripts/verify-bridge.sh", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, DSH_MCP_URL:url, DSH_BRIDGE_SECRET:synthetic }, timeout:15000
    });
    assert.match(stdout, /VERIFY_BRIDGE PASS/);
    assert.ok(!stdout.includes(synthetic));
  } finally {
    bridge.server.closeAllConnections?.();
    await bridge.stop();
  }
});

test("read file refuses traversal, symlink escape and session/cwd ambiguity", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-path-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  await writeFile(path.join(root, "outside.fixture"), "synthetic outside fixture");
  await writeFile(path.join(cwd, "RESULT.md"), "synthetic result");
  await symlink(path.join(root, "outside.fixture"), path.join(cwd, "escape.fixture"));
  const config = normalizeConfig({ workspaceAllowlist: [cwd] });
  const tool = createTools({ ctx: {sessionController:{}}, config, roots:[cwd] }).tools.find(t => t.name === "dsh_read_workspace_file");
  assert.equal((await tool.handler({cwd,path:"RESULT.md"})).content, "synthetic result");
  for (const relative of ["../outside.fixture", "escape.fixture"]) {
    await assert.rejects(tool.handler({cwd,path:relative}), e => e.code === "FORBIDDEN_WORKSPACE");
  }
  await assert.rejects(tool.handler({cwd,path:"/etc/passwd"}), isBadRequest);
  await assert.rejects(tool.handler({cwd,sessionId:"session-fixture",path:"RESULT.md"}), isBadRequest);
  await assert.rejects(tool.handler({path:"RESULT.md"}), isBadRequest);
});
