# 工具参考（0.2.2）

共12工具。下列inputSchema从本版本lib/tools.js导出，与0.2.1工具面保持一致（create的产品描述改为通用配置别名）。机器可读版见[tool-schemas.json](tool-schemas.json)，单测校验它与源码完全一致。

## 传输、返回与错误

协议支持2025-06-18、2025-03-26、2024-11-05；POST JSON-RPC至本机/mcp，Bearer鉴权，Content-Type application/json，Accept application/json, text/event-stream。initialize后notifications/initialized，再tools/list/tools/call；不需要Mcp-Session-Id。GET不支持。

工具调用成功：`result={content:[{type:"text",text:"<JSON>"}],isError:false,structuredContent:<object>}`。content文本超过512KiB会截断，structuredContent并不依此截断，不应仅靠文本推断全量结果。失败通常HTTP200但`result.isError=true`，content文本为`ERROR <code>: <message>`。客户端必须检查isError。

常见工具码：BAD_REQUEST（参数、队列动作、显式工作区路径不符）、NOT_FOUND（会话/文件不存在）、FORBIDDEN_WORKSPACE（白名单/路径逃逸）、RATE_LIMITED、HOST_ERROR；部分未映射的文件系统/Host异常可能保留原始code或Error名称，不应假定只有这些枚举。路径错误可在工具执行时失败，即使schema只是声明了string。服务器并非通用JSON Schema验证器，调用者应按schema传入字段。

传输HTTP：401凭据无效/不可读，403非loopback Origin，404端点错误，405非POST，415非JSON，413超体积（断开连接时客户端也可能只见连接错误），400 JSON格式错误。JSON-RPC：-32700解析、-32600请求、-32601方法、-32602工具名/参数入口、-32603内部错误。工具失败不应切内部API绕过。

## 限流和边界

默认**prompt与steer合计30次/分钟**，**全部工具合计240次/分钟**（prompt也占总桶）。同桥进程的客户端共享滚动窗口；进程重启清空。follow每次schema≤30000ms、≤200事件；0.2.2 handler也硬限制这些值，即使配置试图扩大。默认8000ms/50事件。Host须遵守AbortSignal；不能保证恶意/卡死Host在墙钟30秒内结束。readFile默认256KiB/请求体默认1MiB；图片较大时即使字段合法也可能超HTTP body。限流不是计费预算或权限边界。

## `dsh_list_sessions`

**参数**：cwd? 绝对路径；query? 字面正文搜索；limit? 1–100，默认20。

**返回**：`{count,items:[{sessionId,cwd,updatedAt,running,blank,agentAvailable,parentSessionId?,origin?,source?}]}`。按updatedAt降序，仅白名单会话；source只在桥层记录仍存在时出现。

**语义/错误**：query调用Host搜索后与白名单会话取交集。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Optional absolute directory filter (must be inside the allowlist)."
    },
    "query": {
      "type": "string",
      "description": "Optional literal message-content search; results are intersected with the allowlisted sessions."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "description": "Maximum rows, default 20."
    }
  },
  "additionalProperties": false
}
```

</details>

## `dsh_create_session`

**参数**：必填cwd；可选workspaceId/workspaceSlug/title/model/preset/source。model为"provider/model"或{provider,model,reasoningEffort?}；reasoningEffort详见schema。source默认mcp，仅[a-z0-9._-]且≤64字符。

**返回**：`{sessionId,cwd,source,workspaceId?,workspaceTitle?,agentPreset?,title?,model?,warnings?}`。

**语义/错误**：cwd始终必填。Host create使用workspaceId XOR cwd；不匹配显式ID/slug与cwd时报BAD_REQUEST。命名/选模型失败仅warnings，不撤销创建。无title自动用[source]和会话ID尾部命名。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Absolute working directory; must be inside the bridge workspace allowlist. Used for allowlist checks and workspace resolution."
    },
    "workspaceId": {
      "type": "string",
      "description": "Optional Host workspace id. Must own the same canonical path as cwd; otherwise BAD_REQUEST."
    },
    "workspaceSlug": {
      "type": "string",
      "description": "Optional operator-configured workspace alias from workspaceSlugs. Mapped then path-checked against cwd."
    },
    "title": {
      "type": "string",
      "description": "Optional session title."
    },
    "model": {
      "description": "Optional model selection: \"provider/model\" or an object {provider, model, reasoningEffort?}.",
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string"
            },
            "model": {
              "type": "string"
            },
            "reasoningEffort": {
              "type": "string"
            }
          },
          "required": [
            "provider",
            "model"
          ],
          "additionalProperties": false
        }
      ]
    },
    "preset": {
      "type": "string",
      "description": "Optional agent preset name."
    },
    "source": {
      "type": "string",
      "description": "Optional provenance tag recorded by the bridge for this Session (bridge-local, not the Host origin). Default mcp; max 64 chars of [a-z0-9._-]."
    }
  },
  "required": [
    "cwd"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_prompt`

**参数**：必填sessionId；text?/images?至少有有效内容；delivery? queue|steer默认queue。图片为{mediaType,data,name?}，data为base64。

**返回**：`{requestId,sessionId,accepted:true,delivery,source}`。

**语义/错误**：prompt/steer共用30/分钟桶，且占总请求桶。accepted不代表完成。delivery=steer由Host决定，不像dsh_steer那样预检running。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "text": {
      "type": "string",
      "description": "Prompt text (required unless images are supplied)."
    },
    "images": {
      "type": "array",
      "description": "Optional base64 images.",
      "items": {
        "type": "object",
        "properties": {
          "mediaType": {
            "type": "string",
            "enum": [
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/gif"
            ]
          },
          "data": {
            "type": "string",
            "description": "Base64-encoded image bytes."
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "mediaType",
          "data"
        ],
        "additionalProperties": false
      }
    },
    "delivery": {
      "type": "string",
      "enum": [
        "queue",
        "steer"
      ],
      "description": "queue starts/queues a turn; steer injects into the running turn. Default queue."
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_steer`

**参数**：必填sessionId；text?/images?至少一个，图片同prompt。没有delivery参数。

**返回**：`{requestId,sessionId,accepted:true,delivery:"steer",source}`。

**语义/错误**：先校验会话白名单与running，空闲BAD_REQUEST，改用queue。与prompt共享限流。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "text": {
      "type": "string",
      "description": "Steering text (required unless images are supplied)."
    },
    "images": {
      "type": "array",
      "description": "Optional base64 images, same shape as dsh_prompt.",
      "items": {
        "type": "object",
        "properties": {
          "mediaType": {
            "type": "string",
            "enum": [
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/gif"
            ]
          },
          "data": {
            "type": "string",
            "description": "Base64-encoded image bytes."
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "mediaType",
          "data"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_update_queue`

**参数**：必填sessionId、itemId、action:{kind:"edit"|"remove"|"steer",text?}。

**返回**：`{sessionId,itemId,action:<kind>,accepted:true}`。

**语义/错误**：edit需非空text；remove/steer禁止text。steer提前注入运行轮，Host可能因轮次已结束拒绝。先get_status取得queue.id，避免盲目重试。队列项消失/steer不可用映射BAD_REQUEST，会话不存在映射NOT_FOUND。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "itemId": {
      "type": "string",
      "description": "Queue item id from dsh_get_status queue[].id."
    },
    "action": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "edit",
            "remove",
            "steer"
          ]
        },
        "text": {
          "type": "string",
          "description": "Replacement text; required when kind is edit, forbidden otherwise."
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "sessionId",
    "itemId",
    "action"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_cancel`

**参数**：必填sessionId。

**返回**：`{sessionId,accepted:boolean}`。

**语义/错误**：只取消当前轮，不清空pending inbox/queue，不是删除会话。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_get_status`

**参数**：必填sessionId。

**返回**：`{sessionId,cwd,updatedAt,running,active,cursor,queueLength,queue?,pendingInput,agentAvailable,blank,source}`。queueLength可为null；queue为null时省略queue。

**语义/错误**：queue预览[{id,placement,rpcId?,textPreview?}]，正文压空白截断200字符；预览仍可能敏感。source是临时桥层标签，不是Host origin；重启后unknown。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_get_projections`

**参数**：必填sessionId，可选keys:string[]。

**返回**：无投影时`{sessionId,present:false}`；有则`{sessionId,present:true,kind,asOfSeq?,values}`。

**语义/错误**：keys过滤values；未知keys不出现在结果。投影内容由Host决定，本桥不保证领域字段。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional projection keys to return."
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_follow`

**参数**：必填sessionId；sinceSeq默认0、≥0；maxEvents默认50、1–200；timeoutMs默认8000、500–30000；maxMessages? 1–500。

**返回**：`{sessionId,cursor,header,projections,hasMore,records:[{seq,type,time,data}],truncated,timedOut}`。未取得快照时部分字段null。

**语义/错误**：只返回seq>sinceSeq；单快照批次也限制maxEvents。保存已消费最高seq，重复去重；snapshot.cursor不保证等于本次已消费最高seq。timeout为空不代表完成。30s为Host遵守AbortSignal时的等待上限，不是恶意/卡死Host的强制进程终止保证。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "sinceSeq": {
      "type": "integer",
      "minimum": 0,
      "description": "Only return events with seq greater than this cursor."
    },
    "maxEvents": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "description": "Maximum durable events to collect (default 50)."
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 500,
      "maximum": 30000,
      "description": "Follow timeout in milliseconds (default 8000)."
    },
    "maxMessages": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "description": "Optional follow snapshot message budget."
    }
  },
  "required": [
    "sessionId"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_read_workspace_file`

**参数**：必填path，相对路径；sessionId或cwd必须恰好一个；maxBytes默认262144，1–8388608。

**返回**：`{path,bytes,size,truncated,encoding:"utf8"|"base64",content}`。

**语义/错误**：不支持offset；超过maxBytes截断；前8192字节含NUL被视为binary。禁止绝对路径、NUL、..目录外逃逸、符号链接逃逸。目录内文件没有敏感文件名过滤。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Session whose cwd is the base directory."
    },
    "cwd": {
      "type": "string",
      "description": "Explicit absolute base directory (alternative to sessionId)."
    },
    "path": {
      "type": "string",
      "description": "Path relative to the base directory."
    },
    "maxBytes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 8388608,
      "description": "Maximum bytes to read, default 262144."
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false
}
```

</details>

## `dsh_list_artifacts`

**参数**：sessionId或cwd必须恰好一个；glob? string|string[]，1–16个pattern，各≤500字符。

**返回**：`{cwd,count,items:[{path,size,mtimeMs}]}`，文件字段以lib/paths.js为准。

**语义/错误**：默认["**/RESULT*.md","*.md","**/*-RESULT.md","*.json"]；支持*、?、**，非通用完整glob实现；默认深度5、最多200文件。不遍历符号链接；路径清单不是所有文件的保密控制。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "cwd": {
      "type": "string"
    },
    "glob": {
      "description": "Glob pattern (or array of patterns) relative to the base directory, supporting *, ? and **.",
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    }
  },
  "additionalProperties": false
}
```

</details>

## `dsh_list_workspaces`

**参数**：cwd? 绝对路径；includeSessionIds? boolean默认false；sessionIdLimit? 默认50，1–500。

**返回**：`{count,items:[{id,title,path,sessionIdCount,sessionIds?,sessionIdsTruncated?}],warning?}`。

**语义/错误**：仅白名单内工作区；cwd筛选同canonical path，不是任意子目录查找。registry不可用返回空items与warning。sessionIds仅按需返回，勿写入公开报告。 通用错误与限流同上。

<details>
<summary>完整 inputSchema</summary>

```json
{
  "type": "object",
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Optional: only return the workspace that owns this allowlisted path."
    },
    "includeSessionIds": {
      "type": "boolean",
      "description": "When true, include sessionIds (may be long). Default false."
    },
    "sessionIdLimit": {
      "type": "integer",
      "description": "Max sessionIds to return per workspace when includeSessionIds is true. Default 50, max 500."
    }
  },
  "additionalProperties": false
}
```

</details>

