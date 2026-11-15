# Changelog · @dsops/dsh-agent-bridge

## 0.2.2 — 2026-11-16

开源发布：workspaceSlugs 改为运维配置；workspaceAllowlist 必须显式提供非空绝对路径数组，缺省拒绝启动。不再内置部署路径、真实工作区 ID 或产品别名。补齐 12 工具文档、离线单测、通用客户端、Agent 与 SuperAgent 操作手册。MCP serverInfo 同步 0.2.2。

安全补强：follow handler 按公开 schema 硬限制30秒/200事件，并限制单个快照批次返回事件数，避免大快照绕过 maxEvents。

## 0.2.1 — 2026-11-07（feat/bridge-workspace-mcp）

MCP 建会话带 Host `workspaceId`，侧栏进命名工作区，不再落「未分组」。

### 变更

- `inject` 增加 `workspaceRegistry`（与 `sessionController` 并列）。
- `dsh_create_session` 仍必填 `cwd`（allowlist 不变）；新增可选 `workspaceId` / `workspaceSlug`。
  解析顺序：显式 `workspaceId` → `workspaceSlug` → `registry.resolveByPath(cwd)` → `list().find(path)`。
  命中后 Host `create({workspaceId})`（**不**同时传 cwd）；未命中回退 `create({cwd})` 并 `warnings`。
  显式 id/slug 与 cwd 的 canonical path 不一致 → `BAD_REQUEST`。
- 响应增补 `workspaceId` / `workspaceTitle`（旧客户端可忽略）。
- 新增只读工具 `dsh_list_workspaces`（白名单 path 下的侧栏树 JSON）。
- `initialize.serverInfo.version` / `package.json` → `0.2.1`。

### 测试

扩展 unit：workspace XOR 解析、按 cwd / 显式 id / slug、registry 缺失回退、工具数 = 12。

## 0.2.0 — 2026-11-05

插话改方向 + 调排队 + 会话来源标记。Host 侧无改动，只依赖 0.2.2-rc.1 已有的
`sessionController.prompt({mode:'steer'})` / `updateQueue()` / `state().queue`。

### 新增

- `dsh_steer`（第 10 个工具）：插话改方向。`sessionId` + `text`/`images`（至少一个）。
  先读 `state().running`，**不 running 直接 BAD_REQUEST**（Host 会把 steer 静默丢到 next-step，
  调用方会误以为是真插话）；running 时发 `prompt({mode:'steer', requestId:'mcp-steer-<uuid>'})`。
  限流走 prompt 桶。返回 `{requestId, sessionId, accepted, delivery:'steer', source}`。
- `dsh_update_queue`（第 11 个工具）：`sessionId` + `itemId` + `action`。
  - `edit` 需非空 `action.text` → `content:[{type:'text',text}]`；
  - `remove`；`steer`（把排队项提前注入运行中的轮）。
  - 错误映射：`session/queue-item-not-found` → BAD_REQUEST；`session/not-found` → NOT_FOUND；
    `session/steer-unavailable` → BAD_REQUEST；其余 → HOST_ERROR。限流走普通请求桶。
- `dsh_get_status` 附 `queue:[{id, placement, rpcId?, textPreview?}]`（`state.queue` 非 null 时）；
  `textPreview` = 第一条 text 块、压空白、截断 200。
- 来源标记 `source`（**桥层字段，不是 Host `origin`**）：`dsh_create_session` 新增可选 `source`
  （默认 `mcp`，≤64 字符，仅 `[a-z0-9._-]`）；进程内 `Map` 记录 sessionId → `{source, createdAt}`；
  无 `title` 时自动命名 `[<source>] <sessionId 后 8 位>`；`list_sessions`/`create_session`/`get_status`
  回填 `source`（无记录报 `unknown`）。

### 变更

- `tools/list` 9 → **11** 个工具。
- requestId 前缀统一：prompt `mcp-<uuid>`（原 `agent-bridge-<uuid>`）、steer `mcp-steer-<uuid>`。
- `initialize` 的 `serverInfo.version` → `0.2.0`。
- `dsh_prompt` 的 `text`/`images` 校验与内容构建抽成共享函数，`dsh_steer` 复用同一套入参语义。

### 已知限制

- `source` 注册表是**进程内内存**的：Host 重启后丢失，之后 `list_sessions`/`get_status` 对旧会话报
  `unknown`（不伪造）。上限 1000 条，超出按最旧淘汰，只影响标记不影响正确性。
- 自动标题依赖 `rename`；失败只进 `warnings`，不阻断创建。
- `update_queue` 的 `steer` 依赖 Host 的 turn 在跑，Host 报 `steer-unavailable` 时桥映射成 BAD_REQUEST。

### 测试

`node --test test/unit.test.js`：18 项全绿（新增：source 校验、默认标题、注册表淘汰、
`QueueAction` 形状、预览截断、`summarizeQueue`、Host 错误映射、requestId 前缀、
`dsh_steer` 缺 text/images 拒绝、工具数 = 11）。
