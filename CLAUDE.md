# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TencentAgentMemoryBridge bridges [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (a 4-tier long-term memory system: L0 raw dialogue → L1 atomic facts → L2 scenes → L3 user profile) to AI agent platforms via a unified Bridge Server + platform-specific adapters.

**Status**: P1-P3 implemented (bridge-server, mcp-bridge, openclaw-plugin). See [docs/design-overview.md](docs/design-overview.md) (v0.4-draft) for the canonical design.

## Collaboration Workflow

This project uses a multi-agent collaboration model:

| Role | Agent | Responsibility |
| ----- | ----- | ------------- |
| **Developer** | Claude Code | Write code, manage PRs, merge, release |
| **Tester (MCP)** | CodeBuddy | Test `mcp-bridge` package, file issues |
| **Tester (Plugin)** | OpenClaw | Test `openclaw-plugin` package, file issues |

**Process**:

1. Claude Code (me) implements features in branches and opens PRs
2. CodeBuddy / OpenClaw test relevant packages and file **Bug Reports** via GitHub Issues
3. Claude Code responds to issues, fixes in PR branches, and manages merge
4. On merge, follow [Release Strategy](#release-strategy) to publish

Issue and PR templates are in `.github/` — use them to keep reports consistent.

## Architecture

```text
┌─────────────────┐     ┌──────────────┐     ┌──────────────────────────────┐
│  Any MCP Client  │────▶│  MCP Bridge  │────▶│                             │
│ (CodeBuddy,      │     │  (local)     │     │   Bridge Server (public)    │
│  Claude Code,    │     │              │     │   - Auth / Key validation   │
│  Qoder, Reasonix)│     │              │     │   - Sender whitelist        │
└─────────────────┘     └──────────────┘     │   - Request logging          │
                                              │   - HTTP forwarding          │
┌─────────────────┐     ┌──────────────┐     │   POST /api/v1/*            │
│  OpenClaw Agent  │────▶│OpenClaw Plugin│    └──────────┬──────────────────┘
│                  │     │(local hooks)  │               │
└─────────────────┘     └──────────────┘               │
                                                  ┌──────▼───────────────────┐
                                                  │  TencentDB Agent Memory  │
                                                  │  (upstream, via HTTP)    │
                                                  └──────────────────────────┘
```

### Three Layers

| Layer | Location | Responsibility |
| ----- | -------- | ------------- |
| **Bridge Server** | Public server | Validate API key → check sender whitelist → log → forward to TencentDB Gateway |
| **MCP Bridge** | Local (MCP clients) | MCP protocol ↔ HTTP translation, sender configured per client |
| **OpenClaw Plugin** | Local (OpenClaw env) | Lifecycle hooks → HTTP calls, sender configured in plugin config |

**Core principle**: sender is set per-agent, Bridge Server validates and logs it but never modifies it.

### Data Flow

All bridges pass content through untouched — "what the agent gives is what gets forwarded." TencentDB's background pipeline handles L0→L1→L2→L3 extraction.

```text
Agent full dialogue
        │
        ▼  POST /capture { user_content, assistant_content, session_key, sender }
   Bridge Server
        │
        ▼  POST /capture { user_content, assistant_content, session_key }
   TencentDB Gateway
        │
        ├── L0 raw dialogue ← full store
        ├── L1 atomic facts ← background extraction
        ├── L2 scenes ← background aggregation
        └── L3 user profile ← background generation
```

## Planned Project Structure

```
tencent-agent-memory-bridge/
├── packages/
│   ├── bridge-server/        # Public auth/proxy layer
│   ├── mcp-bridge/           # MCP server → HTTP bridge (uses @modelcontextprotocol/sdk)
│   └── openclaw-plugin/      # OpenClaw lifecycle hook plugin
├── examples/
│   ├── codebuddy/            # MCP config examples for CodeBuddy
│   └── claude-code/          # MCP config examples for Claude Code
├── docs/
│   └── design-overview.md    # Full architecture document (v0.4-draft)
├── package.json
└── pnpm-workspace.yaml
```

## Technology Decisions

| Domain | Choice | Why |
| ------ | ------ | --- |
| Monorepo | pnpm workspace | Standard for TS monorepos |
| Language | TypeScript | All targets benefit from TS |
| Bundler | tsup / tsdown | Lightweight, ESM-native |
| Testing | Vitest | Fast, TS-native, pnpm-compatible |
| MCP SDK | `@modelcontextprotocol/sdk` | Official protocol SDK |
| Upstream | TencentDB Agent Memory via HTTP | **No direct npm dependency** — Bridge Server communicates via HTTP to TencentDB Gateway |

## Bridge Server API (planned)

All endpoints in `packages/bridge-server/`:

| Endpoint | Description | Forwards to TencentDB |
| -------- | ----------- | --------------------- |
| `POST /api/v1/recall` | Recall memories | `POST /recall` |
| `POST /api/v1/capture` | Store conversation | `POST /capture` |
| `POST /api/v1/search/memories` | Semantic search L1 | `POST /search/memories` |
| `POST /api/v1/search/conversations` | Search conversations | `POST /search/conversations` |
| `POST /api/v1/session/end` | End session | `POST /session/end` |

Headers: `Authorization: Bearer <apiKey>`, `X-Sender: <sender_id>`

## MCP Tools (planned)

All in `packages/mcp-bridge/`:

| Tool | Maps to | Description |
| ---- | ------- | ----------- |
| `recall_memory` | `POST /api/v1/recall` | Recall relevant memories before generation |
| `store_memory` | `POST /api/v1/capture` | Store dialogue after generation |
| `search_memories` | `POST /api/v1/search/memories` | Semantic search across memory tiers |
| `end_session` | `POST /api/v1/session/end` | End current session |

## OpenClaw Plugin Hook Mapping (planned)

All in `packages/openclaw-plugin/`:

| OpenClaw Hook | HTTP Call |
| ------------- | --------- |
| `before_prompt_build` | `POST /api/v1/recall` |
| `agent_end` | `POST /api/v1/capture` |
| `session_end` | `POST /api/v1/session/end` |

## Agent Registration (Server-Side Whitelist)

```jsonc
// bridge-server config
{
  "agents": {
    "codebuddy": { "name": "CodeBuddy IDE", "apiKeyHash": "<hashed>", "allowedEndpoints": ["recall", "capture", "search"] },
    "claude-code": { "name": "Claude Code CLI", "apiKeyHash": "<hashed>", "allowedEndpoints": ["recall", "capture", "search", "session"] },
    "openclaw": { "name": "OpenClaw Agent", "apiKeyHash": "<hashed>", "allowedEndpoints": ["recall", "capture"] }
  }
}
```

**Extensibility**: Adding a new agent platform requires (1) register agent + apiKey in Bridge Server config, (2) configure SENDER + API_KEY in the agent's MCP settings.

## Development Roadmap

| Phase | Package | Deliverable |
| ----- | ------- | ----------- |
| **P1** | `bridge-server` | API key validation + sender whitelist + HTTP forwarding to TencentDB Gateway |
| **P2** | `mcp-bridge` | MCP tools (recall/store/search/end-session) → HTTP calls to bridge-server |
| **P3** | `openclaw-plugin` | Lifecycle hooks (before_prompt_build → recall, agent_end → capture, session_end → session/end) |
| **P4** | `examples/` | Deployable configs + full integration walkthrough |

## Key Design Constraints

- **Bridge Server is thin**: authenticate, check whitelist, log, forward — no business logic, no memory tier awareness
- **MCP Bridge is stateless**: state lives in TencentDB Agent Memory; the bridge is a pure protocol translator
- **OpenClaw Plugin replaces TdaiCore calls**: same interface, different transport (HTTP instead of local SDK)
- **Sender identity** flows through from agent → MCP client → HTTP headers, enabling per-platform isolation upstream
- **No direct dependency on the memory engine npm package**: all communication happens via HTTP to the deployed TencentDB Gateway

## Document Reference

- [docs/design-overview.md](docs/design-overview.md) — full design document (v0.4-draft, canonical source)
- [CODEBUDDY.md](CODEBUDDY.md) — CodeBuddy-specific instructions
- [README.md](README.md) — project overview (note: slightly behind the design doc — the design doc is the authoritative source)

## Release Strategy

| Package | Channel | Why |
| ------- | ------- | --- |
| `@tencent-agent-memory/mcp-bridge` | **npm publish** | User runs via `npx @tencent-agent-memory/mcp-bridge` — standard MCP delivery |
| `bridge-server` | **GitHub Release** | Deployed server-side, no npm needed |
| `openclaw-plugin` | **GitHub Release** | Referenced in plugin config, fetched from GH |

All packages in this monorepo share the same version number. On release:

1. Update version across all `package.json` files
2. `pnpm publish` for mcp-bridge to npm
3. Tag + GitHub Release for the rest

## Auto Memory Store (Required)

MCP server `agent-memory` provides 4 tools (`store_memory`, `recall_memory`, `search_memories`, `end_session`) backed by a central Bridge Server (`https://memory.kuai-private.top/api/v1`) → TencentDB Agent Memory.

**You MUST follow these rules:**

### Rule 1: Auto-Store After Every Response

After every response, call `store_memory` with **the current turn's content**:

```
store_memory(
  user_content:      "<用户本轮输入>",
  assistant_content: "<你这轮的回复>",
  session_key:       "claude-code-tencent-agent-memory-bridge-{YYYY-MM-DD}"
)
```

**注**：[`Stop` hook](https://docs.anthropic.com/en/docs/claude-code/settings/hooks) 拿不到对话内容，所以必须由你（Claude）主动调用。

### Rule 2: On-Demand Recall (Never Auto)

Do NOT auto-recall before every response. Call `recall_memory` only when:

- 需要之前对话的上下文
- 用户问到了可能存在于长期记忆中的东西
- 不确定用户偏好或项目历史

### Rule 3: Session Key Convention

固定格式 `claude-code-tencent-agent-memory-bridge-{YYYY-MM-DD}`，每天换日期。同一 session 的所有轮次自动关联。

### (Optional) Stop Hook 配置

如果你想让每次 Stop 事件也发一个 session ping（不存内容，仅标记会话活跃），在 `.claude/settings.local.json` 里加：

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "mcp_tool",
        "server": "agent-memory",
        "tool": "end_session",
        "input": {
          "session_key": "claude-code-tencent-agent-memory-bridge-{YYYY-MM-DD}"
        }
      }]
    }]
  }
}
```

注意每次使用前需要把 `{YYYY-MM-DD}` 替换为当天日期。

## Common Commands

*(Not yet available — the monorepo has not been bootstrapped. These are the planned commands once Phase 1 begins.)*

```bash
pnpm install                          # Install all dependencies
pnpm build                            # Build all packages
pnpm test                             # Run all tests
pnpm --filter mcp-bridge dev          # Dev mode for MCP Bridge
pnpm --filter openclaw-plugin build   # Build OpenClaw plugin
```
