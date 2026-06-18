# TencentAgentMemoryBridge 设计文档 v0.4

> **版本**: v0.4-draft  
> **状态**: 设计阶段  
> **日期**: 2026-06-18  
> **上游项目**: [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (v0.3.6, MIT)

---

## 1. 项目定位

**TencentAgentMemoryBridge** 围绕腾讯开源项目 TencentDB Agent Memory（4 层分层记忆引擎）构建桥梁生态，使不同 Agent 平台获得长期记忆能力。

**不做**：自研记忆系统、替代上游引擎、管理持久化和模型推理  
**做**：统一认证 + 协议适配 + 全量转发到上游 TencentDB Gateway

---

## 2. 系统架构

```
                          公网服务器
┌─────────────────────────────────────────────────────────────┐
│  Bridge Server                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  接收 HTTP 请求                                        │  │
│  │  ├── 校验 API Key                                     │  │
│  │  ├── 校验 sender 是否在注册列表中                      │  │
│  │  ├── 记录请求日志 (sender + 接口 + 时间)                │  │
│  │  └── 原样转发到 TencentDB Gateway                     │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │ 内部 HTTP                          │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │  TencentDB Agent Memory Gateway                      │  │
│  │  (上游项目，负责持久化/嵌入/模型/pipeline)             │  │
│  │  endpoints: /recall /capture /search /session/end    │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────┬──────────────────────────────────────┘
                      │ 公网 HTTP (带 apiKey + sender)
                      │
    ┌─────────────────┼───────────────────┐
    │                 │                    │
    ▼                 ▼                    ▼
┌──────────┐   ┌──────────┐   ┌──────────────────┐
│ MCP Client │   │ MCP Client│   │ OpenClaw Plugin  │
│ (CodeBuddy)│   │(ClaudeCode)│   │ (本地 OpenClaw)  │
│ 显式调用工具 │   │ 显式调用工具 │   │ 生命周期钩子自动  │
└────────────┘   └──────────┘   └──────────────────┘
```

### 2.1 三层职责

| 层 | 运行位置 | 职责 |
|---|---------|------|
| **Bridge Server** | 公网服务器 | 校验 Key → 校验 sender → 日志 → 转发到 TencentDB |
| **MCP Client** | 本地（CodeBuddy/Claude Code 等） | MCP 协议 ↔ HTTP 转换，请求自带 sender |
| **OpenClaw Plugin** | 本地（OpenClaw 环境） | 生命周期钩子 → HTTP 转发，配置自带 sender |

**核心原则**：sender 由 Agent 端自行带入配置，Bridge Server **不修改** sender，只校验和记录。

### 2.2 数据流

所有 Bridge 都不处理记忆内容，**Agent 给什么就转发什么**（全量录入），TencentDB 的后台 pipeline 自动处理 L0→L1→L2→L3。

```
Agent 端完整对话
        │
        ▼  POST /capture { user_content, assistant_content, session_key, sender }
   Bridge Server
        │
        ▼  POST /capture { user_content, assistant_content, session_key }
   TencentDB Gateway
        │
        ├── L0 原始对话 ← 全量存储
        ├── L1 原子事实 ← 后台抽取
        ├── L2 场景模块 ← 后台聚合
        └── L3 用户画像 ← 后台生成
```

---

## 3. 三大交付物

### 3.1 Bridge Server（服务端）

薄代理层，核心代码最简单。

**API 定义**：

```
# 所有接口都需要 apiKey + sender
Headers:
  Authorization: Bearer <apiKey>
  X-Sender: <sender_id>

POST /api/v1/recall
  Body: { query, session_key }
  → 校验后转发到 TencentDB POST /recall

POST /api/v1/capture
  Body: { user_content, assistant_content, session_key, session_id?, messages? }
  → 校验后转发到 TencentDB POST /capture

POST /api/v1/search/memories
  Body: { query, limit?, type?, scene? }
  → 校验后转发到 TencentDB POST /search/memories

POST /api/v1/search/conversations
  Body: { query, limit?, session_key? }
  → 校验后转发到 TencentDB POST /search/conversations

POST /api/v1/session/end
  Body: { session_key }
  → 校验后转发到 TencentDB POST /session/end
```

**Agent 注册配置**（服务端白名单）：

```jsonc
// bridge-server config
{
  "agents": {
    "codebuddy": {
      "name": "CodeBuddy IDE",
      "apiKeyHash": "<hashed>",      // API Key 的哈希
      "allowedEndpoints": ["recall", "capture", "search"]  // 该 Agent 可用的接口
    },
    "claude-code": {
      "name": "Claude Code CLI",
      "apiKeyHash": "<hashed>",
      "allowedEndpoints": ["recall", "capture", "search", "session"]
    },
    "openclaw": {
      "name": "OpenClaw Agent",
      "apiKeyHash": "<hashed>",
      "allowedEndpoints": ["recall", "capture"]
    }
  }
}
```

### 3.2 MCP Client（本地）

**作用**：将 MCP 工具调用转为 HTTP 请求发到 Bridge Server。

**支持的 Agent**：CodeBuddy、Claude Code、Qoder、Reasonix 等任何支持 MCP 的工具。

**启动配置格式**（通用）：

```jsonc
// MCP settings 配置
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "BRIDGE_URL": "https://your-server.com/api/v1",
        "API_KEY": "sk-xxx",
        "SENDER": "codebuddy"          // 这里指定 sender
      }
    }
  }
}
```

**暴露的 MCP 工具**（所有 Agent 通用）：

| 工具名 | 说明 | 对应 |
|--------|------|------|
| `recall_memory` | 生成前召回相关记忆 | POST /recall |
| `store_memory` | 生成后存储对话记录 | POST /capture |
| `search_memories` | 语义搜索 L1 记忆 | POST /search/memories |
| `end_session` | 结束当前会话 | POST /session/end |

**扩展性**：新 Agent 加入时，只需：
1. 在 Bridge Server 配置里注册 agent + apiKey
2. 在 Agent 的 MCP settings 里填上对应的 `SENDER` + `API_KEY`

### 3.3 OpenClaw Plugin（本地）

**作用**：取代上游原有的本地 TdaiCore 集成，改为通过 HTTP 调用 Bridge Server。

**生命周期钩子映射**：

```
OpenClaw 钩子                   →  HTTP 请求
──────────────────────          ──────────────────
before_prompt_build             →  POST /api/v1/recall
agent_end                       →  POST /api/v1/capture
session_end                     →  POST /api/v1/session/end
```

**核心逻辑**：

```typescript
class MemoryBridgePlugin {
  private config: { bridgeUrl: string; apiKey: string; sender: string };

  async beforePromptBuild(ctx) {
    return httpPost(`${this.config.bridgeUrl}/recall`, {
      query: ctx.userText,
      session_key: ctx.sessionKey,
    }, {
      Authorization: `Bearer ${this.config.apiKey}`,
      X-Sender: this.config.sender,  // "openclaw"
    });
  }

  async afterAgentEnd(ctx) {
    return httpPost(`${this.config.bridgeUrl}/capture`, {
      user_content: ctx.userInput,
      assistant_content: ctx.assistantOutput,
      session_key: ctx.sessionKey,
    }, {
      Authorization: `Bearer ${this.config.apiKey}`,
      X-Sender: this.config.sender,
    });
  }
}
```

**插件配置**：

```jsonc
// openclaw.json
{
  "memory-bridge": {
    "enabled": true,
    "config": {
      "bridgeUrl": "https://your-server.com/api/v1",
      "apiKey": "sk-xxx",
      "sender": "openclaw"
    }
  }
}
```

---

## 4. 技术依赖

| 包 | 依赖 |
|----|------|
| `bridge-server` | 无特殊依赖，纯 HTTP 转发 |
| `mcp-bridge` | `@modelcontextprotocol/sdk` |
| `openclaw-plugin` | `openclaw` (peer) |

**所有包不直接依赖** `@tencentdb-agent-memory/memory-tencentdb`，Bridge Server 只对 TencentDB Gateway 发 HTTP 请求（上游项目已部署在公网上）。

---

## 5. 项目结构

```
tencent-agent-memory-bridge/
├── packages/
│   ├── bridge-server/           # 服务端：认证 + 转发
│   ├── mcp-bridge/              # MCP 客户端：协议转换
│   └── openclaw-plugin/         # OpenClaw 插件：钩子转发
├── examples/
│   ├── codebuddy/               # CodeBuddy MCP 配置示例
│   └── claude-code/             # Claude Code MCP 配置示例
├── docs/
│   └── design-overview.md       # 本文件
├── package.json
└── pnpm-workspace.yaml
```

---

## 6. 开发路线图

| Phase | 内容 | 交付 |
|-------|------|------|
| **P1** | bridge-server：Key 校验 + sender 白名单 + HTTP 转发 | 可验证的转发服务 |
| **P2** | mcp-bridge：MCP 协议转 HTTP，recall/store/search 三个工具 | CodeBuddy 和 Claude Code 可接入 |
| **P3** | openclaw-plugin：生命周期钩子转 HTTP | OpenClaw Agent 可接入 |
| **P4** | 示例 + 配置文档 + 部署指南 | 三个方向全链路可验证 |

---

> **下一步**：确认设计后，从 **Phase 1（bridge-server）** 开始编码。
