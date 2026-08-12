# OpenClaw 官方插件接入指南

> **版本**: v0.3.0 · OpenClaw 接入团队版（MemoryCore `/v3/*`）
> **状态**: 自研 openclaw-plugin 已退役，改用官方 `memory-tencentdb-client`

## 概述

OpenClaw 不再使用本项目自研的插件（已退役——它指向已废弃的 bridge-server）。改用**上游官方插件** `memory-tencentdb-client`：生命周期钩子 + v3 SDK 直连 MemoryCore Gateway。

官方插件源码在上游仓库：`TencentDB-Agent-Memory/MemoryCore/openclaw-plugin/`（分支 `feat/server_team`）。

## 能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 钩子 | `before_prompt_build` | 召回记忆注入（L1 搜索 + L3 persona + L2 场景导航） |
| 钩子 | `agent_end` | L0 对话捕获（`/v3/conversation/add`） |
| 工具 | `tdai_memory_search` | 搜索 L1 结构化记忆（`/v3/atomic/search`） |
| 工具 | `tdai_conversation_search` | 搜索 L0 原始对话（`/v3/conversation/search`） |
| 工具 | `tdai_read_cos` | 按相对路径读记忆文件（scene_blocks / persona.md 等） |

## 安装

```bash
# 克隆上游（或已有副本）
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/MemoryCore/openclaw-plugin

# 装依赖 + 构建 + 安装到 OpenClaw
npm install
npm run build
openclaw plugins install -l .

# 重启 gateway 生效
openclaw gateway restart
```

## 配置

编辑 `~/.openclaw/openclaw.json`，在 `plugins.entries.memory-tencentdb-client.config` 填入：

```jsonc
{
  "plugins": {
    "slots": { "memory": "memory-tencentdb-client" },
    "entries": {
      "memory-tencentdb-client": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "server": {
            "url": "https://memory.kuai-private.top",
            "apiKey": "<gate-api-key>",
            "instanceId": "default",
            "teamId": "<team-id>",
            "agentId": "<openclaw-agent-id>",
            "userId": "<user-id>"
          },
          "recall": {
            "maxResults": 5,
            "includePersona": true,
            "includeSceneNav": true
          },
          "capture": { "enabled": true }
        }
      }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `server.url` | MemoryCore Gateway 地址 |
| `server.apiKey` | 网关门禁 key（`Authorization: Bearer`） |
| `server.instanceId` | spaceId（`x-tdai-service-id`），如 `default` |
| `server.teamId` / `agentId` / `userId` | v3 隔离三元组（openclaw agent 用 `agt-*` / `usr-*`） |
| `hooks.allowPromptInjection` / `allowConversationAccess` | 仅 OpenClaw **>= 2026.4.24** 需要；更老版本省略 `hooks` 块 |

> ⚠️ 不要填真实 key 到仓库文件；通过本机 `~/.openclaw/openclaw.json` 或环境变量注入。

## 版本兼容

- OpenClaw **>= 2026.4.24**：必须带 `hooks.allowPromptInjection` / `hooks.allowConversationAccess`（否则 L0 捕获被静默拦截）
- OpenClaw **< 2026.4.24**：省略 `hooks` 块（strict schema 不接受这两个字段）

## 验证

1. `openclaw --version` 确认版本
2. 对话一轮后，用 `tdai_memory_search` 搜索刚才的内容，应能召回（L1 后台抽取需稍候）
3. 确认 `~/.openclaw/memory-tdai/` 有新数据（L0 写入）

## 测试隔离

先在 `test-space-002` 验证再切生产：把 `server.instanceId` 临时改为 `test-space-002` + 测试 key，确认 capture/recall 工作后再换回 `default`。
