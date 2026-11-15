# 工作区与侧栏分组

DSH 的 cwd 与 Host 的 workspaceId 不是同一个字段。只给 cwd 的旧会话可能显示为「未分组」。先 `dsh_list_workspaces` 取得白名单内的 `{id,title,path}`，再用匹配的 workspaceId + cwd 建会话；不要伪造 ID。

## 解析顺序

1. 显式 workspaceId：registry.get 查找；不存在、服务方法缺失或 canonical path 与 cwd 不一致 → BAD_REQUEST。
2. workspaceSlug：从 config.workspaceSlugs 查配置别名（默认空），未知别名拒绝；先用映射 ID 查 registry，找不到时用配置的 id/path/title，均需路径与 cwd 一致。
3. registry.resolveByPath(cwd)：有匹配则使用；失败继续下一步。
4. registry.list().find(path)：先精确路径再 canonical path 比较。
5. registry 不可用或自动解析没匹配 → 返回 null，create({cwd})，响应 warnings，可能「未分组」。未知 slug 即使 registry 不可用也拒绝。

显式 ID 优先于**已知** slug；建议只提供其中一个。未知 slug 会在解析前拒绝，不会因同时给 ID 被静默忽略。registry 缺失时即使给已知 ID/slug 也按基线回退 null；调用者必须检查 warnings，不能误认为已绑定。

## Host create 的 XOR

MCP create 总是必填 cwd 进行白名单检查，但传给 Host 时是二选一：匹配成功仅 `create({workspaceId,...})`，未匹配才 `create({cwd,...})`；不能同时传两者。响应增补 workspaceId/workspaceTitle 用于确认绑定。

```yaml
workspaceAllowlist:
  - /home/dsops/projects/your-project
workspaceSlugs:
  example:
    id: 00000000-0000-4000-8000-000000000001
    path: /home/dsops/projects/your-project
    title: Example project
```

这是占位配置，不能直接指向真实 workspace；在 Host UI 注册目录、用 dsh_list_workspaces 核对，再替换 ID。slug 不创建工作区，也不扩大白名单。工作区列表仅返回白名单 path；可选 includeSessionIds=true，sessionIdLimit 默认50、最大500。source 是桥层临时标记，不是 Host origin，也不是权限或持久所有权。
