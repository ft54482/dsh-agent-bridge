# 远程客户端必须 SSH 本地转发

运维者先在自己的 SSH config 配置一个批准的 Host 别名 `dsh-host`（本示例不包含地址、账号或密钥）。在运行 MCP 客户端的同一电脑上：

```sh
ssh -N -T -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:17300:127.0.0.1:17300 dsh-host
```

前一个127.0.0.1是客户端电脑，后一个是Host电脑。不要使用 `-g`、`-R`、GatewayPorts、公网bind或反向代理。Host桥仍只绑定loopback。端口冲突时可将前一个端口换成17301，并同步客户端 DSH_MCP_URL；切勿改为公网监听。

隧道连接成功不代表MCP已鉴权；客户端仍需通过受控方式配置同一Bearer。不要通过SSH命令打印远程凭据。隧道不负责自动分发secret。停止SSH进程即关闭本地转发，不应重启业务。

在本机运行verify-bridge.sh可验证隧道上的HTTP/工具，但systemd/监听PID归属必须另外在Host核对。云端MCP connector看不到你的本地隧道；请使用本地客户端。
