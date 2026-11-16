# 安装与排障

## 前提

已有 DSH Host；Node ≥20；Cordis ~4.1.0，session-controller 0.2.2-rc.3（本版针对该版本验收；0.2.2 只声明 0.2.2-rc.1 的写法已退役），Host 服务提供 workspaceRegistry。DSH 插件管理器对 bundle 的声明版本有硬性不兼容检查：声明的 DSH peer 与运行中的 DSH 不匹配时直接拒绝安装（`incompatible-version`），绕过需要运维者显式接受 version exemption 的风险。此插件不是独立 Host，不提供模型凭据，也不替你配置 Agent 的工具权限。本仓没有 Host 源码。所有命令都是**供运维者审查后执行的示例**，不是此项目整理过程已执行的远程操作。

## 1. 本地打包和 Host plugins 安装

```sh
# 在本项目中
node --test test/unit.test.js
npm pack
# 将 tarball 通过操作者选择的受控方式复制到 Host，然后：
cd /absolute/path/to/dsh-host/plugins
npm install --omit=dev --ignore-scripts --no-audit --no-fund /absolute/path/to/dsops-dsh-agent-bridge-0.2.3.tgz
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
# Windows 或没有 bash/python3 时改用途相同的纯 Node 验证器：
node ./scripts/verify-bridge.mjs
```

验证脚本只访问本机 endpoint：无凭据应 401、非本机 Origin 应 403、`initialize` 返回 `serverInfo.name=dsh-agent-bridge` 且 `serverInfo.version` 为语义化版本（本版为 `0.2.3`）、`tools/list` 恰好 12 个工具。验证脚本按名称与 `\d+\.\d+\.\d+` 的形状校验，不锁定具体小版本；若读到的版本不是预期的 `0.2.3`，先确认装进去的是新 tarball。`verify-bridge.sh` 需要 bash 与 python3；`verify-bridge.mjs` 只需 Node ≥20，覆盖同样的只读检查，Windows 上优先用它。可选 `DSH_SERVICE=dsh-web` 开启本机 systemd/PID/监听检查；容器或不同服务管理器需自行核对隔离。脚本不建会话、不发送开发任务；不会自动 SSH。远程运行时先建立 [本地转发](../examples/ssh-tunnel.md)，此时服务/PID检查应另在 Host 上执行。

## Windows 安装与验收

以下是在 Windows 上实际遇到的五个问题，按现象与绕法记录；命令仍是供审查的示例，`<user>` 需替换成实际运行身份。前三条与 DSH 插件管理器如何安装 bundle 有关，第四条是验证脚本的运行时依赖，第五条是 secret 文件。

### 1. 不要用本地目录安装 bundle

把**本地目录**交给插件管理器安装时，pnpm 会把它当作 link，bundle 声明的依赖不会被安装，Loader 随后在加载时报 `ERR_MODULE_NOT_FOUND`。做法是先 `npm pack` 出 tarball，再安装这个 `.tgz`：

```sh
npm pack
# 用插件管理器安装 /absolute/path/to/dsops-dsh-agent-bridge-0.2.3.tgz，而不是目录
```

### 2. bundle 内嵌套 git/URL 依赖会被 pnpm 拒绝

如果用一个薄包装 bundle 依赖 GitHub 上的 `@dsops/dsh-agent-bridge`，pnpm 会报 `ERR_PNPM_EXOTIC_SUBDEP ... blockExoticSubdeps is enabled`，该依赖装不上。可行路线是把本包源码 vendored 进包装包，让它自带 `dsh.bundle.patch`，再按 tarball 安装；不要为此关闭 pnpm 的这类检查。

### 3. 本包本身不是 DSH bundle

本包 `package.json` 没有 `dsh.bundle` 字段，因此直接对仓库执行 `install_bundle` 会报 `not-bundle`（“The package declares no dsh.bundle”）。这是设计如此，不是安装损坏。要作为 bundle 安装，需要外层包装并自带 patch；作为普通插件安装则按第 1 节装 tarball。

### 4. 验证脚本的 bash/python3 依赖

`scripts/verify-bridge.sh` 需要 bash 与 python3，Windows 上通常没有。本版新增纯 Node 的 `scripts/verify-bridge.mjs`（只需 Node ≥20），用途相同：无 Bearer 应 401、外来 Origin 应 403、`initialize` 的 `serverInfo` 为 `dsh-agent-bridge 0.2.3`、`tools/list` 恰好 12 个工具；不锁定具体小版本。它同样不建会话、不发任务、不改配置。

### 5. secret 文件路径与权限

Linux 示例中的 `install -d -m 700`、`chmod 600`、`/home/dsops/...` 在 Windows 上不适用；源码默认的 `DEFAULT_SECRET_FILE` 也是 Linux 路径。因此 **`secretFile` 必须显式设置成 Windows 绝对路径**，例如 `C:/Users/<user>/.dsh/bridge.secret`，并确认父目录只对运行身份可访问。生成后用 `icacls` 去掉继承、只授予运行身份完全控制：

```powershell
icacls "C:\Users\<user>\.dsh\bridge.secret" /inheritance:r /grant:r "<user>:F"
```

源码只校验 secret 内容长度，不检查文件 ACL，权限完全由运维者保障；已有文件不要盲目重生成，轮换要与所有客户端同步。

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
|`dsh_list_sessions` 带 `query` 返回 `session search is disabled`|该 Host 关闭了 session-query 索引（如 `openAt: "never"`）；属 Host 配置限制，不是插件缺陷，去掉 `query` 取列表后自行过滤|
|找不到模块/注入服务|确认插件解析位置、peer 版本和 Host 的 workspaceRegistry；不要下载官方源码塞进本仓|
|bundle 装好后 Loader 报 `ERR_MODULE_NOT_FOUND`|是否用本地目录安装？pnpm 会把它当 link，bundle 依赖不会被安装；改用 `npm pack` 的 `.tgz`（Windows 第 1 节）|
|安装 bundle 报 `ERR_PNPM_EXOTIC_SUBDEP ... blockExoticSubdeps is enabled`|bundle 内嵌了 git/URL 依赖；改为 vendored 源码 + 自带 `dsh.bundle.patch` 的 tarball，不要关闭该检查（Windows 第 2 节）|
|安装报 `not-bundle` / "The package declares no dsh.bundle"|本包本身不是 bundle；按插件安装 tarball，或在外层包装一个自带 patch 的 bundle（Windows 第 3 节）|
|安装报 `incompatible-version`|声明的 DSH peer 与运行中的 DSH 不一致；对齐版本，或由运维者在知情后显式接受 version exemption，不要为此改运行中的 DSH|
|`verify-bridge.sh` 报 bash/python3 缺失|改用 `node scripts/verify-bridge.mjs`，只需 Node ≥20（Windows 第 4 节）|
|SSH 端口冲突|选另一**本机 loopback**端口；同步 MCP URL；不启用 GatewayPorts|

回滚：在维护窗口移除本插件 insert 条目并重启 Host；保留原有业务配置。密钥撤销/轮换是独立运维动作，需授权。迁移 0.2.1 → 0.2.2 前必须补 allowlist/slug 配置，否则按设计禁用桥。0.2.2 → 0.2.3 不改配置字段，只是把 DSH peer 声明上调到 0.2.2-rc.3；Host 需先在该版本上，再按 tarball 重装并重跑验证。

## 客户端配置参考

示例按公开客户端文档整理；版本和GUI行为可能变化，发布者应验证实际客户端。

- Cursor MCP 与环境变量插值：https://cursor.com/docs/mcp
- 可选第三方 stdio/HTTP 适配器参数：https://www.npmjs.com/package/mcp-remote

Claude Desktop 示例使用已审计、固定版本的本地可执行适配器路径作为占位；不是要求安装一个名为 reviewed-mcp-remote 的包。`--header-file` 指向仓库外受保护文件；运维者按适配器文档准备 Authorization 头行，不能把真实值提交到配置示例。适配器会接触凭据，其安全性不由本桥单测证明。
