# CODEBUDDY.md

This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

**TencentAgentMemoryBridge** — bridges TencentDB Agent Memory (团队版 v2.0.0, `feat/server_team`) to AI agent platforms.

**v3 isolation**: team/agent/user 三元组替代了旧的 sender 隔离。权威设计见 `docs/team-edition-role-model.md`（三角色模型：用户 / Server Agent / Agent）。

## Architecture

| Package | Role | Status |
|---------|------|--------|
| `mcp-bridge` | MCP stdio → MemoryCore `/v3/*`（官方 SDK） | **保留，重写对齐 v3**（配置 SENDER→TEAM_ID/AGENT_ID/USER_ID） |
| ~~`bridge-server`~~ | ~~Auth + proxy to TencentDB Gateway~~ | **已退役**（团队版自带鉴权取代，见 role-model §1.3） |
| `openclaw-plugin` | OpenClaw lifecycle hooks | **用官方版**（memory-tencentdb-client），不维护自研 |

团队版接入路径：
- Claude Code / WorkBuddy → MemoryProxy（URL + header 预选，协议层透明）
- OpenClaw → 官方 openclaw-plugin（静态配置 teamId/agentId/userId）
- MCP-only 客户端（CodeBuddy 等）→ mcp-bridge（重写对齐 v3，见 role-model §6.5）

## Key Docs

| 文档 | 说明 |
|------|------|
| `docs/team-edition-role-model.md` | 团队版三角色模型（权威设计） |
| `docs/team-edition-role-model-review.md` | PM 评审报告（P0 阻塞项） |
| `docs/design-overview.md` | 旧 v0.4 架构（已过时，仅参考） |

## Tech Stack

pnpm workspace · TypeScript · tsup · Vitest · `@modelcontextprotocol/sdk`

## Commands

```bash
pnpm install && pnpm build
pnpm test
pnpm lint          # tsc --noEmit
```

## Release

- `mcp-bridge` → npm publish
- `bridge-server` → **已退役**，移出发布清单
- `openclaw-plugin` → 用官方版，无自研发布
