# CLAUDE.md

TencentAgentMemoryBridge 桥接 TencentDB Agent Memory（**团队版 v2.0.0**，`feat/server_team` 分支）到 AI Agent 平台（Claude Code / OpenClaw / WorkBuddy）。团队版已引入 **MemoryProxy**（透明 LLM 代理）与 **v3 isolation**（team/agent/user 三元组），旧 `/capture` `/recall` 等 API 与 sender 隔离已移除。

> 权威设计见 [docs/team-edition-role-model.md](docs/team-edition-role-model.md)（三角色模型：用户/Server Agent/Agent；架构决策：bridge-server 退役、mcp-bridge 重写对齐 v3）。

## 协作模型

- 我（Claude Code）：写代码、管 PR、合并、发布
- CodeBuddy / OpenClaw：测试 mcp-bridge / openclaw-plugin，经 GitHub Issues 提 Bug
- Issue/PR 模板在 `.github/`；发布统一版本号

## 架构

- **MemoryProxy**（团队版）：Claude Code/WorkBuddy 接入，URL `/{agent}/{spaceId}/v1/*` + header 预选（`x-team-id`/`x-agent-id`）
- **openclaw-plugin**（官方）：OpenClaw 接入，静态配置 `teamId/agentId/userId`
- **mcp-bridge**（保留，重写对齐 v3）：MCP-only 客户端 → MemoryCore `/v3/*`（官方 SDK），配置 `TEAM_ID/AGENT_ID/USER_ID`
- ~~bridge-server~~ **已退役**：旧 sender 鉴权/转发被团队版自带鉴权取代

## 记忆（MemoryProxy 透明回流）

Claude Code 指向 MemoryProxy（`ANTHROPIC_BASE_URL`）后记忆自动处理，无需显式工具调用：

- **capture**：每轮对话自动回流 L0
- **inject**：L2/L3 自动注入 system prompt
- **工具**：L1/L0 按需经 `<tdai_memory_tools>` 查询
- **身份**：`x-team-id` / `x-agent-id` / `x-task-id` header 预选
- **前置**：需完成迁移步骤（role-model §10）后生效

## 文档

- [docs/team-edition-role-model.md](docs/team-edition-role-model.md) — 团队版三角色模型（权威）
- [docs/design-overview.md](docs/design-overview.md) — 旧架构设计（已过时，仅参考）

## 命令

```bash
pnpm install / build / test
pnpm --filter mcp-bridge dev
pnpm --filter openclaw-plugin build
```
