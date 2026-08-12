# mcp-bridge v3 使用指南

> **版本**: 0.3.0 · 面向团队版（MemoryCore `/v3/*`）
> **状态**: 全量重写完成，直连 MemoryCore Gateway，不再依赖 bridge-server

## 概述

mcp-bridge v3 是 MCP（Model Context Protocol）服务器，把 AI Agent 的记忆工具调用**直连**到 MemoryCore Gateway（团队版 `/v3/*` 数据面）。相比 v0.2：

- ❌ 移除 bridge-server 中转（已退役）
- ❌ 移除 sender 隔离（改为 v3 隔离三元组 team/agent/user）
- ❌ 移除 `end_session` 工具（v3 无对应端点，session 只是客户端 key）
- ✅ 新增多层级召回（`recall_memory` 合并 L1 事实 + L3 persona + L2 场景索引）

## 配置

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MEMORY_ENDPOINT` | ✅ | MemoryCore Gateway 地址（如 `https://memory.kuai-private.top`） |
| `API_KEY` | ✅ | 网关门禁 key（`Authorization: Bearer`，多 agent 共用） |
| `SERVICE_ID` | ✅ | memory 实例 id / spaceId（`x-tdai-service-id`） |
| `TEAM_ID` | ✅ | v3 隔离：团队 id |
| `AGENT_ID` | ✅ | v3 隔离：agent id（每平台一个） |
| `USER_ID` | ✅ | v3 隔离：user id |
| `USER_KEY` | ❌ | 该 agent 的 user_key（meta 面鉴权用，可选） |
| `SESSION_KEY` | ❌ | 默认 session key；缺省自动生成 `<AGENT_ID>-<YYYY-MM-DD>` |
| `TIMEOUT_MS` | ❌ | 请求超时（毫秒，默认 15000） |

完整占位符示例见 [`packages/mcp-bridge/.env.example`](../packages/mcp-bridge/.env.example)。

### MCP settings.json 示例（Claude Code / CodeBuddy）

```jsonc
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "MEMORY_ENDPOINT": "https://memory.kuai-private.top",
        "API_KEY": "<gate-api-key>",
        "SERVICE_ID": "default",
        "TEAM_ID": "<team-id>",
        "AGENT_ID": "<agent-id>",
        "USER_ID": "<user-id>"
      }
    }
  }
}
```

> ⚠️ 不要填真实 key 到仓库文件；通过本机 `.env`（已被 `.gitignore` 排除）或 MCP settings 的 env 字段注入。

## 工具

| 工具 | 映射到 v3 | 说明 |
| --- | --- | --- |
| `recall_memory(query, limit?, include_persona?, include_scenes?)` | `/v3/atomic/search` + `/v3/core/read` + `/v3/scenario/ls` | 多层级召回，返回 `{facts, persona?, scenes?}` |
| `store_memory(user_content, assistant_content, session_key?)` | `/v3/conversation/add` | 写 L0，必填 session |
| `search_memories(query, limit?, type?)` | `/v3/atomic/search` | L1 语义搜索，返回 `{items}` |

## 本地测试

```bash
cd packages/mcp-bridge
# 配置真实 key 到本机 .env（勿提交）
pnpm build
pnpm test
```

## 安全

- 真实 key 只放本机 `.env` / 环境变量，`/f/Project/TencentAgentMemoryBridge/.gitignore` 已排除 `.env`
- 网关门禁 `API_KEY` 多 agent 共用；agent 身份由 `AGENT_ID` + `USER_ID` 区分
- 数据面写入需隔离三元组；测试时用独立 `spaceId`（如 test-space-002）避免污染生产
