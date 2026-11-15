# 安装与排障

## 前提

已有 DSH Host；Node ≥20；Cordis ~4.1.0，session-controller 0.2.2-rc.1，Host 服务提供 workspaceRegistry。此插件不是独立 Host，不提供模型凭据，也不替你配置 Agent 的工具权限。本仓没有 Host 源码。所有命令都是**供运维者审查后执行的示例**，不是此项目整理过程已执行的远程操作。

## 1. 本地打包和 Host plugins 安装

```sh
# 在本项目中
node --test test/unit.test.js
npm pack
# 将 tarball 通过操作者选择的受控方式复制到 Host，然后：
cd /absolute/path/to/dsh-host/plugins
npm install --omit=dev --ignore-scripts --no-audit --no-fund /absolute/path/to/dsops-dsh-agent-bridge-0.2.2.tgz
```

以 Host 的实际 plugin 解析目录为准，确认 `@dsops/dsh-agent-bridge` 可解析，不能将源码简单放进一个任意目录就假定已加载。不要为解决依赖而覆盖 Host 的官方包；安装器的 peer 解析行为需在隔离副本验证。生产维护前备份配置，检查 npm 计划与变更范围。

## 2. 生成专用 secret（不要在本仓执行）

以 **Host 运行身份**执行，示例采用约定 home；如你的运行身份不同请修改绝对路径和 secretFile。不得复用网页 cookie、GitHub token 或其他服务凭据。

```sh
install -d -m 700 /home/dsops/.dsh
# 用 noclobber 防止覆盖已有凭据；不向终端输出生成值。
( umask 077; set -o noclobber; openssl rand -hex 32 > /home/dsops/.dsh/bridge.secret )
chmod 600 /home/dsops/.dsh/bridge.secret
```

上例适用于 bash。已有文件不要盲目重生成；轮换要与客户端同步。源码校验内容长度，不强制检查文件权限/属主，因此权限由操作者保障。不要把实际 secret 放进工单、日志、RESULT、命令行参数或客户端仓库配置。客户端需通过受控凭据渠道取得同一值。

## 3. 配置插件

将 [示例](../examples/cordis.patch.yml) 的 `insert` 条目合并到 **Host 实际读取的** `cordis.patch.yml`。不要覆盖其他插件，不要把示例 UUID 当实际 Host workspace ID。先在 Host UI 注册目标工作区，再从只读列工作区结果确认 ID/path；路径必须实际存在且由 Host 身份可访问。

`workspaceAllowlist` 必填、非空、绝对路径；`workspaceSlugs` 默认空映射，每个条目必须有非空字符串 id/path/title，path 必须绝对。未知配置字段、非法值会禁用桥，不会启动一个宽权限的降级桥。

可调项默认值：host=127.0.0.1，port=17300，path=/mcp，secretMinLength=32，promptPerMinute=30，requestsPerMinute=240，followDefaultTimeoutMs=8000，followMaxTimeoutMs=30000，followMaxEvents=200，readFileMaxBytes=262144，artifactsLimit=200，artifactsMaxDepth=5，maxBodyBytes=1048576。请保留 follow 安全默认，不扩大上限。配置可接受的完整范围见 lib/config.js。

## 4. 重启并验收

若你的 Host 服务名是 dsh-web，取得批准后可执行 `systemctl restart dsh-web`（所需权限依部署而定）。这会中断 Host 进程及其内存 source 标记；按维护窗口执行，**不重启业务应用**。

```sh
systemctl is-active dsh-web
ss -lntp 'sport = :17300'
# 确认只有 loopback，PID 属于预期 Host；不要只看 HTTP 成功就放行。
# 预先通过本机凭据管理设置 DSH_BRIDGE_SECRET_FILE，且不要启用 shell xtrace：
./scripts/verify-bridge.sh
```

验证脚本只访问本机 endpoint：无凭据应 401、非本机 Origin 应 403、initialize 版本正确、tools/list 恰好 12 个。可选 `DSH_SERVICE=dsh-web` 开启本机 systemd/PID/监听检查；容器或不同服务管理器需自行核对隔离。脚本不建会话、不发送开发任务；不会自动 SSH。远程运行时先建立 [本地转发](../examples/ssh-tunnel.md)，此时服务/PID检查应另在 Host 上执行。

## 常见故障

|症状|检查|
|---|---|
|没有监听|Host 加载插件了吗？配置错误、未知字段、缺 allowlist、secret 不可读/过短、白名单目录不存在都会禁用桥|
|401|客户端与 Host secret 是否一致？文件轮换/属主错误？不要打印 secret 排查|
|403|Origin 是否非 loopback？不要通过关闭校验来解决|
|404 / 405 / 415|路径须 /mcp；POST；application/json；不支持 GET SSE|
|RATE_LIMITED|退避并串行 follow；所有 Agent 共享进程内桶|
|工作区未分组|看 create warnings；registry、cwd 与真实 workspace ID 是否相符？见 workspaces.md|
|模型/标题没变|看 warnings，创建已经成功，不要重复建会话造成双跑|
|找不到模块/注入服务|确认插件解析位置、peer 版本和 Host 的 workspaceRegistry；不要下载官方源码塞进本仓|
|SSH 端口冲突|选另一**本机 loopback**端口；同步 MCP URL；不启用 GatewayPorts|

回滚：在维护窗口移除本插件 insert 条目并重启 Host；保留原有业务配置。密钥撤销/轮换是独立运维动作，需授权。迁移 0.2.1 → 0.2.2 前必须补 allowlist/slug 配置，否则按设计禁用桥。

## 客户端配置参考

示例按公开客户端文档整理；版本和GUI行为可能变化，发布者应验证实际客户端。

- Cursor MCP 与环境变量插值：https://cursor.com/docs/mcp
- 可选第三方 stdio/HTTP 适配器参数：https://www.npmjs.com/package/mcp-remote

Claude Desktop 示例使用已审计、固定版本的本地可执行适配器路径作为占位；不是要求安装一个名为 reviewed-mcp-remote 的包。`--header-file` 指向仓库外受保护文件；运维者按适配器文档准备 Authorization 头行，不能把真实值提交到配置示例。适配器会接触凭据，其安全性不由本桥单测证明。
