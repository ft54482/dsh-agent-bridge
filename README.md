# DeepSeek Harness Agent Bridge

`@dsops/dsh-agent-bridge` **0.2.3** · MIT · Node.js ≥20

让其他 Agent 通过 MCP 操作 DeepSeek Harness（DSH）的同一套 **Web Session**：列工作区、建会话、派短任务、观察执行、取回交付物。人类在 Harness 侧栏实时看见这些会话。本项目仅包含自研 Cordis 插件、客户端与文档，不包含 DeepSeek 官方 Host 源码；**不是 DeepSeek 官方产品，也不代表其提供支持或背书**。

## 为什么只允许 loopback

Bearer 可以驱动有开发权限的 Agent，不应成为公网开发执行入口。桥在 Host 进程内单独监听 `127.0.0.1:17300/mcp`，不挂业务 Web 路由、不复用浏览器 cookie。远程客户端必须用 SSH **本地**转发；绝不要监听 `0.0.0.0`，也不要用反向代理、隧道发布服务把桥暴露公网。

```text
Cursor / Claude Desktop / other MCP Agent
             │ Streamable HTTP + Bearer
             ▼
127.0.0.1:17300  ← 远程使用时 SSH -L → Host 127.0.0.1:17300
                                             │
                                  Cordis dsh-agent-bridge
                                    ├─ workspaceRegistry
                                    └─ sessionController
                                             │
                              同一套 Web Session / Host Agent
                                             │
                                allowlisted project directory
```

## 快速安装（在 DSH Host 上，由运维者执行）

完整说明见 [安装](docs/install.md)。本包不是独立启动的 HTTP 服务，不要直接执行 `node lib/index.js`。

1. 已有运行正常的 DSH Host、Node ≥20；确认 Host 提供 `@deepseek-ai/cordis ~4.1.0` 和 `@deepseek-ai/dsh-api-session-controller 0.2.2-rc.3`，并加载 workspaceRegistry。其他 DSH 版本未承诺兼容；经插件管理器以 bundle 安装时，声明不匹配会直接被拒，见[兼容性](#兼容性)。
2. `npm pack`，把本包安装到该 Host 的 `plugins` 目录（见安装文档的本地 tarball 示例）。无需打包 Host 源码。
3. 以 Host 运行身份生成 **32+ 随机字节**的独立 secret，文件权限 600、上级目录 700；不要打印、粘贴到聊天或提交它。Windows 上这些 POSIX 权限写法不适用，须显式设置绝对 `secretFile` 并用 `icacls` 限制，见[安装](docs/install.md)。
4. 将 [cordis.patch.yml](examples/cordis.patch.yml) 的 `insert` 合并进 Host 配置；必须显式设置非空 `workspaceAllowlist`，可选设置 `workspaceSlugs`。示例路径、UUID 都是占位符。
5. 在维护窗口由有权限的运维者重启 `dsh-web`，再运行 `scripts/verify-bridge.sh`（需要 bash + python3）或纯 Node 的 `scripts/verify-bridge.mjs`（Windows 推荐）。部署/重启需要自己取得相应授权；本项目整理与单测不会执行这些操作。

## 兼容性

- 已验收组合：DSH **0.2.2-rc.3** + `@deepseek-ai/cordis ~4.1.0` + Node.js ≥20，Windows 本机 loopback。本版声明 `peerDependencies["@deepseek-ai/dsh-api-session-controller"] = "0.2.2-rc.3"`。
- 0.2.2 中只声明 `0.2.2-rc.1` 的写法在 0.2.3 退役；不对其他 DSH 版本作兼容承诺。
- DSH 插件管理器有硬性不兼容检查：bundle 声明的 DSH peer 与运行中的 DSH 版本不匹配时拒绝安装（`incompatible-version`）。改用 version exemption 需要运维者显式接受风险；不要为了让旧声明装上而放宽这一确认。
- 验收事实：`initialize` → `serverInfo` 为 `dsh-agent-bridge 0.2.3`（版本取自 `package.json`，与发布号一致）；`tools/list` → 12 个唯一工具，且 12 个工具均已实跑；一个真实会话返回 `BRIDGE_E2E_OK`，projections / queue / cancel / steer 行为正常；`dsh_list_workspaces` → 3 个白名单根；`dsh_list_sessions` 有返回行；`dsh_read_workspace_file` 读取相对路径文件并拒绝 `../../../Windows/win.ini`（`ERROR FORBIDDEN_WORKSPACE: path escapes the session working directory`）；无 Bearer → 401、外来 Origin → 403；监听仅 `127.0.0.1:17300`。
- Windows 的安装坑（目录安装变 link、bundle 内 git 依赖被拒、`not-bundle`、secret 权限命令）见[安装文档](docs/install.md)的 Windows 一节。

## 12 个工具

|工具|用途|
|---|---|
|`dsh_list_sessions`|列白名单下 Web Session，可按 cwd / query 过滤|
|`dsh_create_session`|建会话，挂到命名工作区|
|`dsh_prompt`|开始/排队任务，默认 delivery=queue|
|`dsh_steer`|改变正在执行的任务方向，空闲拒绝|
|`dsh_update_queue`|编辑、删除或提前注入排队项|
|`dsh_cancel`|取消当前轮，不清空队列|
|`dsh_get_status`|状态、游标与队列正文短预览|
|`dsh_get_projections`|投影快照|
|`dsh_follow`|有限等待并取得增量事件|
|`dsh_read_workspace_file`|相对工作目录读取交付文件|
|`dsh_list_artifacts`|按 glob 查交付物|
|`dsh_list_workspaces`|列侧栏命名工作区|

完整参数、返回和错误见 [工具参考](docs/tools.md)；[schema JSON](docs/tool-schemas.json) 从本版本源码导出。

## 典型调用

先 `initialize` → `notifications/initialized` → `tools/list`，然后：

1. `dsh_list_workspaces({})`，选择授权目标的 `id` 与 `path`。
2. `dsh_create_session({cwd:"/home/dsops/projects/your-project",workspaceId:"00000000-0000-4000-8000-000000000001",source:"mcp",title:"Investigate failing test"})`。
3. `dsh_prompt({sessionId:"<returned-session-id>",text:"仅调查与补测，不合并部署。交付 RESULT.md；回复末行 RESULT: READY。",delivery:"queue"})`。
4. 交替 `dsh_follow` 与 `dsh_get_status`，保存已经消费的最高 seq；空事件或 accepted=true 都不代表完成。
5. 用 `dsh_list_artifacts` 与 `dsh_read_workspace_file` 取回 `RESULT.md`，核对测试证据、提交 SHA、未完成项与授权范围，再独立验收。

详细流程见 [Agent 手册](docs/agent-playbook.md) 和可装载的 [skill](skills/deepseek-harness-mcp.md)。

## MCP 客户端

- **Cursor**：将 [示例](examples/cursor-mcp.example.json) 合并到本机 `~/.cursor/mcp.json`。原生 HTTP URL + Authorization header，使用 `${env:DSH_BRIDGE_SECRET}` 插值；GUI 启动的进程也必须继承该环境。绝不把实际值写入仓库。
- **Claude Desktop**：静态 Bearer 不等于 OAuth connector。可用审计并固定版本的第三方 `mcp-remote` 进行 stdio → HTTP 转换，见 [示例](examples/claude-desktop.example.json)；headers 文件由操作者在仓库外创建、chmod 600。该适配器不随本包安装，须自行审查其凭据处理。
- **任意 Streamable HTTP MCP client**：POST 本机 `/mcp`，设置 `Content-Type: application/json`、`Accept: application/json, text/event-stream` 与 Bearer；无状态、不发 `Mcp-Session-Id`，返回 JSON，不提供持久 GET SSE。协议版本见工具参考。
- **客户端不在 Host 上**：先按 [SSH 本地转发](examples/ssh-tunnel.md) 建隧道，再连接本机 URL。云端 connector 不能访问你电脑的 loopback，不能为兼容它而开放公网。

## 与 SuperAgent 的关系

**本 MCP 没有 SuperAgent 工单工具**。Web Session 是短调查/验证任务入口；长时间开发应在目标 GitHub 仓开 Issue，正文 `@<agent-login> <request>`，由官方 `dsh-superagent` 插件轮询接单。需要仓库权限、插件配置与明确的发单授权；创建 Issue 是外部写操作，不因能用 MCP 就获得许可。见 [SuperAgent](docs/superagent.md)，不要调用内部 orchestrator HTTP API。

## 安全边界与限制

- 配置缺白名单、未知字段、不合法路径/slug、非 loopback bind 均拒绝启动；secret 缺失/空/过短时不开放监听。
- Bearer + SHA-256 后 `timingSafeEqual`；外部 Origin 返回 403；不读/复用 owner 的 cookie。
- 会话 cwd 须白名单内；读文件用相对路径，阻止目录外 `..` 与符号链接逃逸。**这不是沙箱**：目录内所有可读内容仍可被取回，不要将凭据放入白名单。
- 桥本身不执行 git 写操作、不重启、不部署、不记录 prompt 正文，但受它驱动的 Host Agent 可执行代码和写文件。任务书权限约束不等于操作系统隔离。
- 默认 prompt/steer 共 30 次/分钟；所有工具共 240 次/分钟（prompt 也占总桶）。follow schema 单次 ≤30 秒、≤200 事件；不要调高生产边界。
- Host 重启后桥层 source 丢失变成 unknown；自动标题/模型选择失败以 warnings 返回，不回滚已建会话。
- 若 Host 关闭了 session-query 索引（例如 `openAt: "never"`），`dsh_list_sessions` 带 `query` 会返回 `session search is disabled`。这是 Host 配置限制，不是桥的缺陷：去掉 `query` 取列表再自行过滤。
- 已在 Windows 上对 DSH 0.2.2-rc.3 完成本机 loopback 实机验收（见[兼容性](#兼容性)）；其他平台、远程 SSH 转发和既有部署仍需各自验收，离线单测不能替代实机检查。

完整威胁模型见 [安全说明](docs/security.md)；漏洞报告见 [SECURITY.md](SECURITY.md)。

## 开发与发布

```sh
node --test test/unit.test.js
npm pack --dry-run
```

纯 Node 单测不要求真实 Host、网络或凭据（仅生成合成测试 fixture）。贡献须遵守 [CONTRIBUTING.md](CONTRIBUTING.md)。仓库地址预设为 `https://github.com/ft54482/dsh-agent-bridge`，不表示已经创建或发布；本地完成不会自动 push / npm publish。

[English](README.en.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)
