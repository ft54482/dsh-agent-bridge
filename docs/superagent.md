# SuperAgent 与 MCP Web Session：两个入口

**本桥的12个工具里没有 SuperAgent 工单、队列、作业启动/停止 API。** 它不代替官方 dsh-superagent 插件，也不安装该插件。不要发明 `dsh_dispatch_superagent` 等工具，不要调用未公开的 orchestrator HTTP API。

## 长任务正规流程

1. 目标 GitHub 仓已经由官方 `dsh-superagent` 插件配置为监听仓；运维者已设定隔离工作目录、机器人身份和最小仓库权限。凭据由官方插件管理，不经过本桥。
2. 核对目标仓、基础分支/SHA、验收标准、现有补丁和缺失测试，确认没有同一任务双跑。
3. **只有取得开 Issue 的具体授权后**，在目标仓创建 Issue，正文使用：

```text
@<agent-login> <request>

目标：<可核验的开发目标>
基线：<branch / SHA>；现有补丁：<links>
允许：<目录、代码变更、测试范围>
禁止：未经批准的合并、部署、业务重启、扩大权限、读取凭据
验收：<保持原验收标准，补齐缺失测试和失败路径>
交付：变更说明、提交SHA、完整测试命令与结果、未解决风险；提交PR但不合并
```

4. 由官方插件轮询接单（不是 MCP 调用创建的 session）。在 GitHub Issue/PR 与官方插件公开 UI 中跟踪进度和交付，独立验收；CI 全绿不等于人工判据裁定。
5. 不具备仓库权限、机器人读仓404、插件监听错仓、隔离目录不一致时停止发单，请运维修正。切仓/改配置/重启服务须明确授权并制定恢复步骤，不能由普通 MCP 调查任务自行做。

本仓不规定官方插件配置细节，部署者应核对其当前官方说明。不要把「能创建 Web Session」包装成「SuperAgent 已接单」。

## 短任务

调查、验证、限定范围的短修复可通过 MCP 创建 Web Session，按 [Agent 手册](agent-playbook.md) 发任务、follow、取 RESULT。它们可修改工作区（取决于 Host Agent），但没有 SuperAgent 工单生命周期和 GitHub 跟踪语义。MCP 不赋予开 Issue、推送、合并或部署许可。
