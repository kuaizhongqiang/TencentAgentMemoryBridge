# AgentMemory 团队版 v3 架构参考

## 三角色模型

| 角色 | 说明 | 对应字段 |
|------|------|---------|
| 用户 (User) | 自然人，拥有记忆数据 | `USER_ID` (`usr-xxx`) |
| Server Agent | 平台级代理，管理团队和空间 | `SERVICE_ID` (`default`) |
| Agent | 具体 AI 接入端 | `AGENT_ID` (`agt-xxx`) |

## 隔离机制

team/agent/user 三元组替代旧 sender 隔离：

- **同 team 同 user 不同 agent** → 独立记忆域（如 claude-code vs codebuddy vs openclaw vs deepseek-harness）
- **MemoryProxy**（透明代理）：Claude Code / WorkBuddy 用，自动回流 L0
- **mcp-bridge**（MCP 工具）：CodeBuddy IDE / CLI / DeepSeek Harness 用，需显式或 Hook 自动存档

## task_id（项目级隔离，与身份严格分离）

- `task_id` 是**项目级隔离标签**（如项目目录名 / 显式 `TASK_ID`），L1 事实按它隔离召回；**不是身份 id**
- 绝不把 `AGENT_ID`（`agt-*`）/ `TEAM_ID`（`team-*`）/ `USER_ID`（`usr-*`）/ key 当 `task_id`——mcp-bridge ≥ 0.4.0 启动即拒绝这类前缀
- 未设 `TASK_ID` 时自动从项目路径（cwd 目录名）派生，每项目不同

## 数据面

- L0：对话记忆（`/v3/conversation/add` 写入）
- L1：原子事实（语义搜索）
- L2：场景索引
- L3：persona（人格/偏好）

## 网关

- 公网：`https://memory.kuai-private.top`
- 门禁：`API_KEY` (Bearer token)
- Service ID：`default`

## 凭据来源

密钥信息通常从 `mem-agent-keys-*.md` 或 MemoryCore 管理后台获取。

关键字段：
- `API_KEY` — 网关门禁 key（所有 agent 共用）
- `USER_KEY` — 用户级 key（`sk-mem-...`，可选，meta 面用）
- `TEAM_ID` — 团队 ID (`team-xxx`)
- `AGENT_ID` — Agent ID (`agt-xxx`)，每个接入端独立
- `USER_ID` — 用户 ID (`usr-xxx`)
