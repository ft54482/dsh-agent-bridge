# scripts/

Read-only acceptance checks for a running local bridge. Neither script creates
sessions, sends prompts, writes files, or restarts services.

- `verify-bridge.sh` — POSIX, needs bash + python3. Checks the fail-closed 401/403
  paths, `initialize` serverInfo, and the 12-tool schema surface; with `DSH_SERVICE`
  set it also checks `systemctl`/`ss` listener ownership on the Host.
- `verify-bridge.mjs` — cross-platform, Node >= 20, no dependencies. Same protocol
  checks plus `dsh_list_workspaces`, `dsh_list_sessions`, a relative
  `dsh_read_workspace_file` read and `../../` traversal rejection; supports
  `--json` and `--base-dir`, and skips the file checks outside allowlisted roots.

Run `./scripts/verify-bridge.sh` (POSIX) or `node scripts/verify-bridge.mjs` (any OS).
