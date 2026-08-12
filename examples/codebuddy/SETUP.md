# CodeBuddy MCP 安装 / 更新指南

> **目标**: 让 CodeBuddy 自己能安装或更新 `agent-memory` MCP（连接团队版记忆 `MemoryCore /v3/*`）
> **版本**: mcp-bridge ≥ 0.3.1 · 本指南面向 CodeBuddy 作为接入方

---

## 1. 它是什么

`tencent-agent-memory-mcp-bridge` 是一个 MCP 服务器，直连团队版 MemoryCore `/v3/*`，提供 3 个记忆工具：

| 工具 | 功能 |
| --- | --- |
| `recall_memory` | 多层级召回（L1 事实 + L3 persona + L2 场景索引） |
| `store_memory` | 写 L0（对话记忆） |
| `search_memories` | L1 语义搜索 |

## 2. 前置条件

- MemoryCore Gateway 公网可达：`https://memory.kuai-private.top`
- 一份有效的**门禁 key**（`API_KEY`）和 **CodeBuddy 的 user_key**（`USER_KEY`，可选）
- 当前最新版本：`0.3.1`（`npm view tencent-agent-memory-mcp-bridge version` 可查）

## 3. 配置（CodeBuddy 身份）

CodeBuddy 的隔离三元组（与 Claude 同 team / user，**agent_id 不同**）：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `MEMORY_ENDPOINT` | `https://memory.kuai-private.top` | 网关地址 |
| `API_KEY` | `<gate-api-key>` | 网关门禁 key（共用，从密钥文件取） |
| `SERVICE_ID` | `default` | spaceId |
| `TEAM_ID` | `team-w7eai9w6kc` | my-workspace |
| `AGENT_ID` | `agt-w7entnc8iw` | **codebuddy**（区别于 claude-code 的 `agt-w7end3dcl9`） |
| `USER_ID` | `usr-w7easao7jg` | kuai-user |
| `USER_KEY` | `<codebuddy-user-key>` | CodeBuddy 的 `sk-mem-...`（可选，meta 面用） |
| `TASK_ID` | 不填 | 自动从项目路径派生（每项目独立） |

> ⚠️ **不要填真实 key 到仓库文件**。真实值在 `mem-agent-keys-*.md`（本机）或 MCP 配置的环境变量里。

## 4. 安装

### 方式 A：全局安装（推荐，npx 直接命中最新版）

```bash
npm install -g tencent-agent-memory-mcp-bridge@latest
```

安装后验证：`npm ls -g tencent-agent-memory-mcp-bridge`

### 方式 B：MCP settings 配置（npx 按需拉取）

在 CodeBuddy 的 MCP 配置里加：

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "tencent-agent-memory-mcp-bridge"],
      "env": {
        "MEMORY_ENDPOINT": "https://memory.kuai-private.top",
        "API_KEY": "<gate-api-key>",
        "SERVICE_ID": "default",
        "TEAM_ID": "team-w7eai9w6kc",
        "AGENT_ID": "agt-w7entnc8iw",
        "USER_ID": "usr-w7easao7jg"
      }
    }
  }
}
```

参考: `examples/codebuddy/codebuddy.json`

## 5. 更新

```bash
# 1. 看当前最新版
npm view tencent-agent-memory-mcp-bridge version

# 2. 升级全局安装
npm install -g tencent-agent-memory-mcp-bridge@latest

# 3. 确认
npm ls -g tencent-agent-memory-mcp-bridge
```

> 用全局安装时，`npx -y tencent-agent-memory-mcp-bridge` 会命中全局最新版；若发现跑了旧版，先升级全局再重启 CodeBuddy。

## 6. 验证

1. 检查 MCP 已连接（工具列表里应有 `recall_memory` / `store_memory` / `search_memories`）
2. 调 `store_memory` 存一条测试消息 → 应返回 `accepted_ids`
3. 调 `recall_memory` 搜刚才的内容 → 稍后（L1 后台抽取）应能召回

## 7. 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `Bridge server error` | 还在跑旧版（<0.3.0） | 全局升级到 ≥0.3.1，重启 |
| `401 Unauthorized` | 门禁 key 不对或过期 | 核对 `API_KEY` |
| 工具里没有 `agent-memory` | MCP 未连上 | 检查 endpoint / 网络 / env 是否完整 |
| `recall` 返回空 facts | L1 后台抽取未完成 | 等几分钟再试 |
