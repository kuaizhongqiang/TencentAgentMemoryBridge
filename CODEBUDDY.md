# CODEBUDDY.md

This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

**TencentAgentMemoryBridge** — bridges [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) to AI agent platforms via a unified Bridge Server + platform-specific adapters.

Current architecture (v0.4):

```text
Agent (CodeBuddy/Claude Code)
  │  MCP stdio
  ▼
mcp-bridge  ──HTTP──▶  bridge-server  ──HTTP──▶  TencentDB Gateway
     (local MCP server)   (auth + proxy)             (memory engine)
```

Three deliverables:

| # | Package | What it does |
| --- | ------- | ------------- |
| 1 | `bridge-server` | Auth + sender whitelist + logging + HTTP proxy to TencentDB |
| 2 | `mcp-bridge` | MCP stdio server with 4 tools (recall/store/search/end-session) |
| 3 | `openclaw-plugin` | OpenClaw lifecycle hooks mapped to bridge-server HTTP calls |

## Tech Stack

| Domain | Choice |
| ------ | ------ |
| Monorepo | pnpm workspace |
| Language | TypeScript |
| Build | tsup |
| Test | Vitest |
| MCP SDK | `@modelcontextprotocol/sdk` |

## Release

- **mcp-bridge** → npm publish (for `npx @tencent-agent-memory/mcp-bridge`)
- **bridge-server** + **openclaw-plugin** → GitHub Release

## Test

```bash
pnpm install
pnpm build
pnpm test
pnpm lint        # tsc --noEmit
```

## Architecture Docs

Read `docs/design-overview.md` before making changes.
