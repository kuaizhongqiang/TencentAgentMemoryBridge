# CLAUDE.md

TencentAgentMemoryBridge 桥接 TencentDB Agent Memory（**团队版 v2.0.0**，`feat/server_team` 分支）到 AI Agent 平台（Claude Code / OpenClaw / WorkBuddy）。团队版已引入 **MemoryProxy**（透明 LLM 代理）与 **v3 isolation**（team/agent/user 三元组），旧 `/capture` `/recall` 等 API 与 sender 隔离已移除。

> 权威设计见 [docs/team-edition-role-model.md](docs/team-edition-role-model.md)（三角色模型：用户/Server Agent/Agent；架构决策：bridge-server 退役、mcp-bridge 重写对齐 v3）。

## 协作模型

- 我（Claude Code）：写代码、管 PR、合并、发布
- CodeBuddy / OpenClaw：测试 mcp-bridge / OpenClaw 官方插件接入，经 GitHub Issues 提 Bug
- Issue/PR 模板在 `.github/`；发布统一版本号

## 架构

- **MemoryProxy**（团队版）：Claude Code/WorkBuddy 接入，URL `/{agent}/{spaceId}/v1/*` + header 预选（`x-team-id`/`x-agent-id`）
- **openclaw-plugin**（官方）：OpenClaw 接入，静态配置 `teamId/agentId/userId`
- **mcp-bridge**（保留，重写对齐 v3）：MCP-only 客户端 → MemoryCore `/v3/*`，配置 `TEAM_ID/AGENT_ID/USER_ID`（+ 可选 `TASK_ID`）；接入方含 Claude Code / CodeBuddy / **DeepSeek Harness**（DSH 原生 MCP 客户端，见 [docs/deepseek-harness-v3.md](docs/deepseek-harness-v3.md)）
- ~~bridge-server~~ **已退役**：旧 sender 鉴权/转发被团队版自带鉴权取代

## task_id 与身份（严格分离）

- `team_id` / `agent_id` / `user_id` = **身份**（meta 面注册实体，`agt-*` / `team-*` / `usr-*`），跨项目不变
- `task_id` = **项目级隔离标签**（项目目录名或显式 `TASK_ID`），每项目不同
- mcp-bridge ≥ 0.4.0 启动时拒绝 `agt-`/`team-`/`usr-`/`sk-` 前缀的 `task_id`——**不要把身份 id 当 task_id 用**

## 记忆（MemoryProxy 透明回流）

Claude Code 指向 MemoryProxy（`ANTHROPIC_BASE_URL`）后记忆自动处理，无需显式工具调用：

- **capture**：每轮对话自动回流 L0
- **inject**：L2/L3 自动注入 system prompt
- **工具**：L1/L0 按需经 `<tdai_memory_tools>` 查询
- **身份**：`x-team-id` / `x-agent-id` / `x-task-id` header 预选
- **前置**：需完成迁移步骤（role-model §10）后生效

> 本仓库 `.claude` 实际走 **mcp-bridge + Stop hook** 自动入库：`scripts/stop-memory-store.mjs` 在每次响应结束后把最后一轮写入 L0（凭据读 `.claude/settings.local.json` → `mcpServers.agent-memory.env`），无需模型手动调 `store_memory`（去重 state 在 `.claude/.memory-store-state.json`）。模型仍按需调用 `recall_memory` / `search_memories`。
>
> DeepSeek Harness 走 **mcp-bridge + 守护脚本** 自动入库：`scripts/dsh-memory-autostore.mjs` 监听 `~/.dsh/sessions` 的会话日志（`turn/end` 事件）自动提交每轮对话（凭据复用 `~/.dsh/profiles/web/cordis.patch.yml` → `mcp-agent-memory.env`，task_id 从会话 cwd 派生）。

## 文档

- [docs/team-edition-role-model.md](docs/team-edition-role-model.md) — 团队版三角色模型（权威）
- [docs/mcp-bridge-v3.md](docs/mcp-bridge-v3.md) — mcp-bridge v3 使用指南
- [docs/deepseek-harness-v3.md](docs/deepseek-harness-v3.md) — DeepSeek Harness 接入指南
- [docs/openclaw-plugin-v3.md](docs/openclaw-plugin-v3.md) — OpenClaw 官方插件接入
- [docs/design-overview.md](docs/design-overview.md) — 旧架构设计（已过时，仅参考）

## 命令

```bash
pnpm install / build / test
pnpm --filter mcp-bridge dev
```
