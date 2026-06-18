# TencentAgentMemoryBridge

围绕 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 构建的记忆桥梁生态——将 4 层长期记忆能力（L0 对话 → L1 原子事实 → L2 场景 → L3 画像）接入不同的 Agent 平台。

**不造轮子**，所有记忆引擎能力由 TencentDB Agent Memory 提供，本仓库仅做协议桥接。

## 架构

```text
┌─────────────────┐     ┌──────────────┐     ┌──────────────────────────────┐
│  Any MCP Client  │────▶│  MCP Bridge  │────▶│                             │
│ (CodeBuddy,      │     │  (local)     │     │   Bridge Server (public)    │
│  Claude Code,    │     │              │     │   - Auth / Key validation   │
│  Qoder, Reasonix)│     │              │     │   - Sender whitelist        │
└─────────────────┘     └──────────────┘     │   - 按 sender 隔离记忆域     │
                                              │   - Request logging          │
┌─────────────────┐     ┌──────────────┐     │   - HTTP forwarding          │
│  OpenClaw Agent  │────▶│OpenClaw Plugin│    │   POST /api/v1/*            │
│                  │     │(lifecycle hooks)   └──────────┬──────────────────┘
└─────────────────┘     └──────────────┘               │
                                                  ┌──────▼───────────────────┐
                                                  │  TencentDB Agent Memory  │
                                                  │  (upstream, via HTTP)    │
                                                  └──────────────────────────┘
```

### 三层

| 层 | 位置 | 职责 |
| -- | ---- | ---- |
| **Bridge Server** | 公网服务器 | API key 校验 → sender 白名单 → 日志 → 转发到 TencentDB Gateway |
| **MCP Bridge** | 本地 (MCP clients) | MCP 协议 ↔ HTTP 翻译，Sender 按客户端配置 |
| **OpenClaw Plugin** | 本地 (OpenClaw 环境) | 生命周期 hooks → HTTP 调用，Sender 在插件配置中 |

### 核心原则

**Sender 由各 Agent 自行声明**，Bridge Server 校验其合法性并记录，但永不修改。每次 `recall` 自动限定在本 sender 域，确保编码分析和日常对话的记忆互不干扰。

## 记忆域隔离

每个 sender 拥有独立的记忆域：

| Sender | 用途 | 跨域搜索 |
| ------ | ---- | -------- |
| `claude-code` | 编码分析 | ❌ |
| `codebuddy` | 编码调试 | ❌ |
| `openclaw` | 日常对话 | ✅ 通过复杂命令 |

- **capture**：Bridge Server 自动注入 sender 到转发请求，上游按 sender 标记
- **recall**（MCP 工具）：自动仅召回本域记忆，工具不暴露 `sender` 参数
- **recall**（HTTP API）：支持 `sender` / `senders` 参数，跨域需 `crossDomainRecall` 权限

## 快速开始

### 1. 部署 Bridge Server

```bash
# 配置环境变量
export PORT=3000
export TENCENTDB_URL=https://your-tencentdb-gateway
export AGENTS='[
  { "name": "claude-code", "apiKeyHash": "<sha256>", "allowedEndpoints": ["recall","capture","search","session"] },
  { "name": "codebuddy", "apiKeyHash": "<sha256>", "allowedEndpoints": ["recall","capture","search"] },
  { "name": "openclaw", "apiKeyHash": "<sha256>", "allowedEndpoints": ["recall","capture"], "crossDomainRecall": true }
]'

# 启动
npx @tencent-agent-memory/bridge-server
```

### 2. 配置 MCP Bridge（Claude Code / CodeBuddy）

在 `.claude/settings.json` 或对应 MCP 客户端配置中注册：

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "BRIDGE_URL": "https://your-server.com/api/v1",
        "API_KEY": "sk-your-api-key",
        "SENDER": "claude-code"
      }
    }
  }
}
```

> 各 Agent 的 `SENDER` 不同，以此隔离记忆域。详见 [Claude Code 配置指南](examples/claude-code/SETUP.md)。

### 3. OpenClaw Plugin

在 OpenClaw 插件配置中填写：

```json
{
  "bridgeUrl": "https://your-server.com/api/v1",
  "apiKey": "sk-your-api-key",
  "sender": "openclaw"
}
```

插件自动在 `before_prompt_build`（recall）和 `agent_end`（capture）等生命周期钩子中桥接记忆。

## MCP 工具

| 工具 | 端点 | 说明 |
| ---- | ---- | ---- |
| `recall_memory` | `POST /api/v1/recall` | 生成前召回相关记忆 |
| `store_memory` | `POST /api/v1/capture` | 生成后存储对话 |
| `search_memories` | `POST /api/v1/search/memories` | 语义搜索记忆 |
| `end_session` | `POST /api/v1/session/end` | 结束当前会话 |

## 项目结构

```
tencent-agent-memory-bridge/
├── packages/
│   ├── bridge-server/        # 公网认证/代理层
│   ├── mcp-bridge/           # MCP Server → HTTP 桥接
│   └── openclaw-plugin/      # OpenClaw 生命周期 hooks
├── examples/
│   ├── codebuddy/            # CodeBuddy 配置示例
│   └── claude-code/          # Claude Code 配置指南
├── docs/
│   └── design-overview.md    # 完整架构文档 (v0.4-draft)
├── CLAUDE.md                 # 项目指令 + Auto Memory Store 规则
└── package.json
```

## 上游依赖

- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — 腾讯开源的 4 层本地长期记忆系统（MIT 协议）

## License

MIT
