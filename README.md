# TencentAgentMemoryBridge

围绕 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) **团队版 v2.0.0**（`feat/server_team` 分支）构建的记忆桥梁——把 4 层长期记忆能力（L0 对话 → L1 原子事实 → L2 场景 → L3 画像）接入不同的 AI Agent 平台。

**不造轮子**：记忆引擎能力全部由 TencentDB Agent Memory 提供，本仓库只做协议桥接。团队版引入 **MemoryProxy**（透明 LLM 代理）与 **v3 isolation**（`team / agent / user` 三元组），旧 `/capture` `/recall` 与 sender 隔离已被取代。

> 权威设计见 [docs/team-edition-role-model.md](docs/team-edition-role-model.md)（三角色模型 + v3 接入）。

## 架构

```text
┌───────────────┐   ┌───────────────────────────────┐
│ Claude Code / │──▶│  MemoryProxy（团队版，透明 LLM）│──▶ MemoryCore /v3/*
│ WorkBuddy     │   │  URL /{agent}/{spaceId}/v1/*   │
└───────────────┘   │  header 预选 x-team-id/x-agent-id │
┌───────────────┐   └───────────────────────────────┘
│ MCP-only 客户端 │──▶┌───────────────────────┐        │
│ (Claude Code, │   │  mcp-bridge (v3 重写)   │────────▶ MemoryCore /v3/*
│  CodeBuddy,   │   │  配置 TEAM/AGENT/USER 三元组 │
│  DSH)         │   └───────────────────────┘        │
└───────────────┘   ┌───────────────────────┐        │
┌───────────────┐   │  openclaw-plugin(官方)  │────────▶ MemoryCore /v3/*
│ OpenClaw      │──▶│  静态配置 teamId/agentId│
└───────────────┘   └───────────────────────┘
```

| 组件 | 状态 | 接入方 | 说明 |
| ---- | ---- | ---- | ---- |
| **MemoryProxy** | ✅ 团队版核心 | Claude Code / WorkBuddy | 透明 LLM 代理：URL `/{agent}/{spaceId}/v1/*` + header 预选；每轮对话自动回流 L0，L2/L3 自动注入 system prompt，无需显式工具调用 |
| **mcp-bridge** | ✅ v3 重写（0.4.0） | MCP-only 客户端（Claude Code / CodeBuddy / **DeepSeek Harness**） | 直连 MemoryCore `/v3/*`，配置隔离三元组 `TEAM_ID/AGENT_ID/USER_ID` + 可选 `TASK_ID`；工具结果回显 `_context` 隔离域 |
| **openclaw-plugin** | ✅ 官方插件 | OpenClaw | 上游官方实现，静态配置 `teamId / agentId / userId` |
| **bridge-server** | ❌ **已退役** | — | 旧 sender 鉴权/转发被团队版自带鉴权取代 |

### 核心原则

- **v3 隔离三元组**：一切数据面读写都带 `team_id + agent_id + user_id`（可选 `task_id` 做项目级区分），取代旧 sender 白名单
- **task_id 与身份严格分离**：`agent_id`（`agt-*`）是平台身份、跨项目不变；`task_id` 是项目级标签（目录名或显式 `TASK_ID`），**拒绝 `agt-`/`team-`/`usr-`/`sk-` 前缀**（mcp-bridge ≥ 0.4.0 启动即校验），杜绝身份 id 被当 task_id 用
- **单团队作用域**：`/v3/atomic/search`、`/v3/core/read`、`/v3/scenario/ls` 都在当前 team 内检索
- **召回与写入分离**：L1 按需经工具查询；L0 由 MemoryProxy 透明回流或 mcp-bridge 显式/Stop hook 写入

## 三种接入方式

### 1. MemoryProxy（透明，推荐）

Claude Code / WorkBuddy 把 `ANTHROPIC_BASE_URL`（或 OpenAI 兼容端点）指向 MemoryProxy，记忆自动处理：

- **capture**：每轮对话自动回流 L0，无需显式工具调用
- **inject**：L2/L3 自动注入 system prompt
- **身份**：URL 路径 `/{agent}/{spaceId}` + `x-team-id` / `x-agent-id` / `x-task-id` header 预选（或首轮表单选择）

前置：需完成团队版部署与迁移步骤（见 role-model §10）。

### 2. mcp-bridge（MCP-only 客户端）

MCP 服务器，把记忆工具调用**直连** MemoryCore Gateway（团队版 `/v3/*` 数据面）。配置见 [docs/mcp-bridge-v3.md](docs/mcp-bridge-v3.md)。

```jsonc
// .claude/settings.local.json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "tencent-agent-memory-mcp-bridge"],
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

> ⚠️ 真实 key 只放本机 `.env` 或 MCP settings env，**不要提交到仓库**。

### 3. OpenClaw（官方插件）

用上游官方 openclaw-plugin，静态配置 `teamId / agentId / userId`。见 [docs/openclaw-plugin-v3.md](docs/openclaw-plugin-v3.md)。

### 4. DeepSeek Harness（DSH 原生 MCP）

DSH 通过原生 MCP 客户端插件（`@deepseek-ai/dsh-mcp-client`）连接 mcp-bridge，模型看到 `mcp__agent-memory__*` 工具。配置模板见 [examples/deepseek-harness/cordis.patch.yml](examples/deepseek-harness/cordis.patch.yml)，完整指南见 [docs/deepseek-harness-v3.md](docs/deepseek-harness-v3.md)。

## 自动入库（默认提交、按需取回）

### Claude Code / CodeBuddy（Stop hook）

mcp-bridge 本身是**工具服务器**：`store_memory` 只有模型显式调用才写入。为保证"对话生成完成后自动发送"，通过 **Stop hook** 兜底：

- **脚本**：[scripts/stop-memory-store.mjs](scripts/stop-memory-store.mjs)——每次响应结束，从 transcript 提取最后一段 user/assistant 文本，POST 到 MemoryCore `/v3/conversation/add`
- **配置**：`.claude/settings.local.json` 的 `hooks.Stop`（凭据从同一文件的 `mcpServers.agent-memory.env` 读取，单一事实源）
- **去重**：按 `session_id` + 最后 assistant 时间戳写 `.claude/.memory-store-state.json`，防止 /compact、/resume 重复入库
- **不阻塞**：写入失败仅记 stderr、exit 0，不拖慢对话

```jsonc
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "command": "node scripts/stop-memory-store.mjs", "timeout": 30 }] }]
}
```

### DeepSeek Harness（守护脚本）

DSH 没有 Stop hook，用独立守护脚本 [scripts/dsh-memory-autostore.mjs](scripts/dsh-memory-autostore.mjs) 实现同样语义：

- **原理**：监听 `~/.dsh/sessions/**/session.jsonl.zstd`（DSH 会话日志，zstd 多帧 JSONL），每个回合结束（`turn/end` 事件）自动把该轮 user + assistant 文本 POST 到 `/v3/conversation/add`
- **身份**：team/agent/user + 门禁 key 复用 DSH 本机配置（`~/.dsh/profiles/web/cordis.patch.yml` → `mcp-agent-memory.env`，单一事实源），支持环境变量覆盖
- **task_id**：从会话 header 的 `cwd` 自动派生（项目目录名），每项目独立
- **去重**：按 `session_id + turn` 写 `~/.dsh/.dsh-memory-autostore-state.json`；启动建基线不回溯历史，只提交之后新增轮次
- **用法**：部署时先 `node scripts/dsh-memory-autostore.mjs --baseline-only`（把现有轮次记为基线，不回溯提交历史），之后 `node scripts/dsh-memory-autostore.mjs --once`（增量提交，配合计划任务）或常驻 `node scripts/dsh-memory-autostore.mjs`（10s 轮询）；`--backfill` 补提交历史；`--dry-run` 只扫描

## MCP 工具

| 工具 | v3 端点 | 说明 |
| ---- | ---- | ---- |
| `recall_memory` | `/v3/atomic/search` + `/v3/core/read` + `/v3/scenario/ls` | 多层级召回，返回 `{facts, persona?, scenes?, _context}` |
| `store_memory` | `/v3/conversation/add` | 写 L0，必填 session（Stop hook 已自动兜底，一般无需显式调） |
| `search_memories` | `/v3/atomic/search` | L1 语义搜索，返回 `{items, _context}` |

> `end_session` 已移除：v3 中 session 只是客户端 key，无独立关闭端点。
> `_context`（≥0.4.0）：每个工具结果回显当前隔离域 `{team_id, agent_id, user_id, task_id}`，模型/用户可据此确认 agent 与 task 未混用。

## 项目结构

```text
tencent-agent-memory-bridge/
├── packages/
│   ├── mcp-bridge/           # MCP Server → MemoryCore /v3/* 直连（v3 重写）
│   └── bridge-server/        # 已退役（旧 sender 代理层，仅保留历史参考）
├── scripts/
│   ├── stop-memory-store.mjs # Stop hook：响应结束后自动写 L0（Claude Code）
│   └── stop-memory-store-codebuddy.mjs # CodeBuddy Stop hook
├── examples/
│   ├── codebuddy/            # CodeBuddy MCP 安装/更新指南
│   ├── claude-code/          # Claude Code 配置指南
│   └── deepseek-harness/     # DeepSeek Harness cordis.patch.yml 模板
├── docs/
│   ├── team-edition-role-model.md   # 团队版三角色模型（权威）
│   ├── mcp-bridge-v3.md             # mcp-bridge v3 使用指南
│   ├── deepseek-harness-v3.md       # DeepSeek Harness 接入指南
│   ├── openclaw-plugin-v3.md        # OpenClaw 官方插件接入
│   └── design-overview.md           # 旧架构设计（已过时，仅参考）
├── CLAUDE.md                 # 项目指令
└── package.json
```

## 本地开发

```bash
pnpm install
pnpm --filter mcp-bridge build
pnpm --filter mcp-bridge test
```

## 上游依赖

- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — 腾讯开源的 4 层长期记忆系统（团队版含 MemoryProxy + v3 isolation）

## License

MIT
