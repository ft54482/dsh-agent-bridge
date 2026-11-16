# DeepSeek Harness Agent Bridge

`@dsops/dsh-agent-bridge` 0.2.3 — MIT — Node.js 20+

An independently developed Cordis plugin exposing the **same Web Sessions visible to humans** through a loopback-only, stateless Streamable HTTP MCP endpoint. This is not an official DeepSeek product. No official Host source is redistributed.

## Architecture and installation

MCP client → local HTTP (+ SSH local forwarding when remote) → Host loopback listener → Cordis `sessionController` / `workspaceRegistry` → Web Sessions and allowlisted projects.

Install this package in your existing DSH Host plugins directory. Required peers: `@deepseek-ai/cordis ~4.1.0` and `@deepseek-ai/dsh-api-session-controller 0.2.2-rc.3`; the Host must also provide workspaceRegistry. Other DSH versions are not claimed as compatible, and the plugin manager refuses mismatched declarations outright (see [Compatibility](#compatibility)). Create a dedicated random secret with 32+ random bytes, mode 600 and a protected parent directory; on Windows the POSIX commands do not apply, so set an explicit absolute `secretFile` and restrict it with `icacls` as described in [installation](docs/install.md). Merge `examples/cordis.patch.yml` into the Host configuration, providing an explicit nonempty absolute `workspaceAllowlist`. Optional `workspaceSlugs` entries require `{id,path,title}`. Missing allowlist fails closed. Restart the Host service only with operator approval. See [installation](docs/install.md).

Default endpoint: `http://127.0.0.1:17300/mcp`. Never publish it through a reverse proxy or public tunnel. Remote clients **must use SSH local forwarding**, with both listeners bound to loopback; see [SSH guide](examples/ssh-tunnel.md).

## Compatibility

Verified combination: DSH **0.2.2-rc.3** with `@deepseek-ai/cordis ~4.1.0` and Node.js ≥20, on Windows against a loopback listener. This release declares `peerDependencies["@deepseek-ai/dsh-api-session-controller"] = "0.2.2-rc.3"`; the 0.2.2 declaration pinned to `0.2.2-rc.1` is retired, and no compatibility is claimed for other DSH versions.

The DSH plugin manager enforces a hard gate: a bundle whose declared DSH peer requirement does not match the running DSH version is refused with `incompatible-version`. Proceeding anyway requires the operator to accept a version exemption explicitly; do not relax that confirmation just to install an outdated declaration.

Acceptance evidence on that combination: `initialize` reports `serverInfo` `dsh-agent-bridge 0.2.3` (the version is read from `package.json`, so it matches the release); `tools/list` returns 12 unique tools and all 12 were exercised end-to-end; a real session answered `BRIDGE_E2E_OK`, and projections / queue / cancel / steer behaved correctly; `dsh_list_workspaces` returns 3 allowlisted roots; `dsh_list_sessions` returns rows; `dsh_read_workspace_file` reads a relative file and rejects `../../../Windows/win.ini` with `ERROR FORBIDDEN_WORKSPACE: path escapes the session working directory`; a request without a Bearer token gets 401, a foreign `Origin` gets 403, and the listener binds `127.0.0.1:17300` only.

Verification helpers: `scripts/verify-bridge.sh` (bash + python3) and the pure-Node `scripts/verify-bridge.mjs`, which needs only Node ≥20 and is the practical option on Windows. Windows installation pitfalls — local-directory installs becoming links, nested git dependencies rejected by pnpm, `not-bundle`, and secret file permissions — are documented in [installation](docs/install.md).

## Clients

Cursor can use native HTTP with `url` and a Bearer `headers` field, interpolated from its process environment. Claude Desktop may use a separately reviewed and version-pinned stdio-to-HTTP adapter (`mcp-remote` example included). Credentials belong in a protected local file or process environment, never this repository. Arbitrary Streamable HTTP clients POST JSON-RPC to the local URL with `Authorization: Bearer …`, `Content-Type: application/json`, and `Accept: application/json, text/event-stream`. No MCP session identifier is issued. This implementation returns JSON, not a persistent GET SSE stream.

## Workflow and tools

Initialize → initialized notification → tools/list → list workspaces → create session using its ID and matching cwd → prompt → follow/status → read artifacts → independently verify results.

The 12 tools are `dsh_list_sessions`, `dsh_create_session`, `dsh_prompt`, `dsh_steer`, `dsh_update_queue`, `dsh_cancel`, `dsh_get_status`, `dsh_get_projections`, `dsh_follow`, `dsh_read_workspace_file`, `dsh_list_artifacts`, and `dsh_list_workspaces`. Exact [schemas](docs/tool-schemas.json) and [reference](docs/tools.md) are included. Agent-ready instructions: [playbook](docs/agent-playbook.md) and [skill](skills/deepseek-harness-mcp.md).

The bridge has **no SuperAgent issue/job tools**. For long development work, explicitly authorized callers create an Issue in the target GitHub repository with `@<agent-login> <request>` in its body. The official `dsh-superagent` plugin polls and processes it. Do not invent an MCP SuperAgent API or call private orchestrator endpoints. See [SuperAgent guide](docs/superagent.md).

## Security and limitations

Only loopback literal bind addresses are accepted. Bearer validation hashes then uses timingSafeEqual. Missing/empty/short secret disables startup; runtime requests re-read it and fail closed. Non-loopback Origin gets 403. No browser cookie reuse. Session cwd must be allowlisted; artifact reads prevent directory escape through relative traversal or symlinks. This is **not a sandbox**: files within permitted roots remain readable and Host Agents may execute code. The bridge itself does not write git or log prompt bodies, but output events and queue previews can contain sensitive content. Never include credential directories in roots. See [security](docs/security.md).

Defaults: prompt/steer share 30 calls/minute; all tools share 240/minute. Follow schema permits up to 30 seconds and 200 events. Source labels are bridge-memory-only and become unknown after restart. Session rename/model errors are warnings, not rollback. If the Host disables its session-query index (for example `openAt: "never"`), `dsh_list_sessions` with `query` answers `session search is disabled`; that is a Host configuration limit, not a bridge defect — list without `query` and filter yourself. Live loopback acceptance was performed on Windows against DSH 0.2.2-rc.3 (see [Compatibility](#compatibility)); remote forwarding, other platforms and existing deployments still need their own check, and offline unit tests do not replace one.

```sh
node --test test/unit.test.js
npm pack --dry-run
```

The proposed GitHub address is metadata, not evidence of publication. Nothing here pushes or deploys automatically. [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [MIT](LICENSE) · [中文](README.md)
