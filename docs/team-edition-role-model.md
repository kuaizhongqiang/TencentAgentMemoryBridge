# 团队版接入方案：角色模型与身份定义

> **版本**: v0.2（依据 PM 评审意见修订）
> **日期**: 2026-08-12
> **上游**: TencentDB Agent Memory v2.0.0（团队版分支 `feat/server_team`）
> **状态**: 已确认架构决策，待实现

---

## 1. 背景与目标

### 1.1 现状

- 服务器已部署**团队版**（v2.0.0，`feat/server_team` 分支）
- 团队版引入 **MemoryProxy**（透明 LLM 代理）与 **v3 isolation**（team / agent / user 三元组）
- 旧 API（`/capture` `/recall` `/search/memories` `/session/end`）与旧 **sender** 隔离机制**已移除**

### 1.2 目标

- 1 个用户（我），多项目运行，每项目多个 agent
- 记忆跨项目共享：我的偏好、决策跨项目可用
- 项目知识可细分（task / 资产绑定）
- 硬隔离场景（客户项目）可兜底（独立 team）

### 1.3 架构决策（已确认）

| 组件 | 决策 | 理由 |
| ---- | ---- | ---- |
| **bridge-server** | **退役** | 团队版 MemoryProxy + MemoryCore 自带鉴权（`user_key → /v3/meta/auth/verify` + Bearer + service-id + ACL），bridge-server 的"鉴权+sender 白名单+转发"被完全取代；三平台接入均不经过它 |
| **mcp-bridge** | **保留并重写对齐 v3** | 为 MCP-only 客户端保留统一 MCP 入口；改为直连 MemoryCore `/v3/*`（官方 SDK），配置升级为隔离三元组 |
| **openclaw-plugin** | 官方 openclaw-plugin | 上游已提供（memory-tencentdb-client），直接用官方版，不维护自研 |
| **CLAUDE.md auto-store** | 简化 | MemoryProxy 透明回流，无需显式 store_memory 调用（旧机制依赖 mcp-bridge + bridge-server，已不可用） |

### 1.4 核心约束（来自团队版机制，决定方案选择）

1. **v3 召回是单团队作用域**：`/v3/atomic/search`、`/v3/core/read`、`/v3/scenario/ls` 全部带 `team_id`，一次请求只能在当前 team 内检索
2. **借入（fixed-asset borrow）仅限同团队**：`tdai-fixed-asset.ts` 里 `parsed.teamId !== selfTeamId` 直接跳过，最多借 2 个 agent
3. **user 可属多团队，但不带来跨团队记忆视图**：召回仍按 team 过滤
4. **因此"把 agent 定义为 user"不可行**：机械上不生效（召回按 team 不按 user），语义上错位（`user_id` 是"被记忆的人"，L3 persona 是"关于这个 user 的画像"）

---

## 2. 总体设计：单团队 + 平台 agent（A1）

```text
Memory Hub
└── Team: my-workspace            ← 一个团队装所有项目
    ├── Agents: claude-code / openclaw / workbuddy   ← 每个平台一个 agent，跨项目共享
    ├── User: 我                   ← 唯一人类用户
    ├── Assets: Wiki / CodeGraph / Skills            ← 项目资产按 agent 可见性绑定
    └── 项目细分: task_id（会话级） + session_key（按日）
```

| 维度 | 取值 | 说明 |
| ---- | ---- | ---- |
| `team_id` | `my-workspace`（统一） | 跨项目共享的前提：同一团队 |
| `agent_id` | 平台名（`claude-code` / `openclaw` / `workbuddy`） | 每平台一份长期记忆 |
| `user_id` | `me`（统一） | 唯一人类，全链路一致 |
| `task_id` | 每次会话动态 | 项目/任务级细分 |
| 硬隔离场景 | 独立 team | 客户/保密项目兜底 |

**为什么选单团队**：只有单团队能让"我"的 persona 和 agent 的长期记忆真正跨项目流动；项目隔离对"一个人 + 自己的项目"是净损失。硬隔离需求用独立 team 兜底。

---

## 3. 角色模型（核心）

系统内设计**三个角色**，职责与隔离边界各不同：

| 角色 | 实体 | 身份 | 权限 | 接入路径 |
| ---- | ---- | ---- | ---- | ---- |
| **用户（我）** | 唯一人类 | `user_id` | 被记忆主体 + Hub 管理员 | 对话使用各 agent / 操作 Hub |
| **Server Agent** | 服务器端管理实体 | 独立服务账号（systemUser） | 可直接操作 Memory Hub（控制面） | MemoryCore `/v3/meta/*` + 运维口 |
| **Agent** | 接入/调用主体 | `team_id + agent_id + user_id` | 数据面读写（记忆/技能/知识） | MemoryProxy / openclaw-plugin / mcp-bridge(v3) |

---

## 4. 角色 1：用户（我）

### 4.1 需要如何操作

**作为 Hub 管理员（System Admin）**：
1. 建团队、建 agent、把自己加为成员
2. 导入 Wiki / CodeGraph，绑定资产到指定 agent
3. 管理可见性（`private` 归自己 / `team` 归团队 / `agent` 精确配给）

**作为日常使用者**：
1. 直接对话使用 Claude Code / OpenClaw / WorkBuddy，记忆透明工作
2. 我的偏好、决策自动沉淀为 L3 persona + L1 事实

**作为鉴权主体**：
1. 持有 `user_key`（`x-tdai-user-key` / `sk-mem-...`），各客户端用它鉴权
2. 首轮会话在 MemoryProxy 交互表单里选 team → agent → task（或 header 预选）

### 4.2 注意事项

- **user 跨团队不自动解锁跨团队召回**——召回按 team 过滤，这是团队版的硬约束
- persona 每 (team, agent) 一份；单团队方案下每平台一份，避免碎片化

---

## 5. 角色 2：Server Agent（重点角色）

### 5.1 身份定位

服务器端运行、**可直接操作 Memory Hub** 的管理实体。对应团队版两个机制：
- **MemoryProxy `systemUsers`**：内部服务账号，命中后**短路透传**（跳过 session init 与注入，不构成对话回合）
- **MemoryCore Meta 控制面**（`/v3/meta/*`）：团队/agent/user 的供给与资产管理

> 实现形态：**先做调度脚本**（建 team/agent、资产导入），后期按需升级为自动化 agent。

### 5.2 需要做什么

| 职责 | 具体动作 | 调用面 |
| ---- | ---- | ---- |
| **Provisioning（供给）** | 建/改团队、agent；分配成员 | `/v3/meta/team/*` `/v3/meta/agent/*` `/v3/team-member/*` |
| **资产管理** | 导入 Wiki/CodeGraph；把资产绑定到指定 agent；审核/共享 Skill | `/v3/knowledge/*` `/v3/meta/agent-fixed-asset/*` |
| **会话与身份维护** | session 注册、task 生命周期 | `/v3/session/*` |
| **可观测与运维** | 监控用量/限流/计费；管理 MemoryProxy 配置（`systemUsers`、`upstream.agents`、`/v3/admin/rate-limits`） | 运维端点 |
| **知识回流** | 周期整理沉淀的记忆资产到合适位置 | 控制面 |

### 5.3 需要注意什么（重点）

1. **安全**
   - 持 admin 级 key，必须走环境变量 / Secret Manager，**严禁进代码库 / 配置仓库**
   - 上游明确警告：真实 `apiKey` / `serviceToken` / STS 凭证 / 计费 URL 不入配置仓库
   - 运维端点鉴权（`TDAI_PROXY_ADMIN_API_KEY`）必须启用
2. **隔离（不污染用户记忆域）**
   - 管理动作（建 agent、导资产）**不是对话** → **不写 L0/L1**
   - 系统调用走 `systemUser` 短路透传，跳过注入与回流
   - 它自己的 `user_id` 不得混入用户的 persona 域
3. **权限最小化**
   - 只授予它需要的 endpoint / ACL
   - ACL 校验必须 **fail-closed**（出错即拒绝，不能静默放行成"全部允许"）
4. **幂等与审计**
   - 管理操作可重复执行、有日志留痕（proxy 三路可观测：ClickHouse / Langfuse / Opik）

---

## 6. 角色 3：Agent（接入/调用主体）

### 6.1 身份定位

与用户对话、通过 bridge 调记忆的 AI agent（Claude Code / WorkBuddy / OpenClaw / MCP-only 客户端）。运行时身份 = `(team_id, agent_id, user_id, session_id, task_id)`。

### 6.2 如何通过 bridge 通信

| Agent | bridge | 协议 | 身份来源 |
| ---- | ---- | ---- | ---- |
| **Claude Code** | MemoryProxy | Anthropic `/v1/messages` | URL `/{agent}/{spaceId}/v1/messages` + header 预选 / 首轮表单 |
| **WorkBuddy** | MemoryProxy | OpenAI `/v1/chat/completions` | URL `/{agent}/{spaceId}/v1/chat/completions` + header / 表单 |
| **OpenClaw** | 官方 openclaw-plugin | HTTP `/v3/*`（SDK） | 插件静态配置 `teamId / agentId / userId` |
| **MCP-only 客户端** | mcp-bridge（v3 重写） | MCP ↔ MemoryCore `/v3/*` | 客户端配置 `TEAM_ID / AGENT_ID / USER_ID` |

### 6.3 运行时身份定义（MemoryProxy 三种机制）

1. **请求头预选**（推荐，可每项目一个身份）：
   ```
   x-team-id: my-workspace
   x-agent-id: claude-code
   x-task-id: <本次任务>
   ```
   配置段 `sessionInit.headerAutoSelect`（默认 `enabled: true`），header 值必须命中用户可见列表，否则按 `onMismatch: "form"` 回退表单。
2. **交互式表单**：首轮弹窗选 team → agent → task，选择结果注入 `<session_context>`。
3. **静态配置**（OpenClaw 走 openclaw-plugin）：`server.teamId / server.agentId / server.userId` 写死。

### 6.4 注意事项

- agent 名从 URL 前缀识别；未识别的 agent 走 `defaultAdapter`（功能可用但未优化）
- 每个 agent 的身份必须在用户可见列表内，否则 header 不被信任
- Claude Code / WorkBuddy 走 MemoryProxy 是**协议层透明**，无需装插件、无需调 MCP 工具

### 6.5 mcp-bridge 重写设计（v3）

**架构**：MCP server → 直连 MemoryCore `/v3/*`（不再经 bridge-server），建议用官方 SDK `@tencentdb-agent-memory/memory-sdk-ts-v2`（与 openclaw-plugin 同源）。

**配置项变化**（旧 → 新）：

| 旧 | 新 |
| --- | --- |
| `BRIDGE_URL` | `MEMORY_ENDPOINT`（MemoryCore `/v3` 地址，如 `http://127.0.0.1:8420`） |
| `API_KEY` | `API_KEY` + `SERVICE_ID`（`x-tdai-service-id` / spaceId） |
| `SENDER` | `TEAM_ID` + `AGENT_ID` + `USER_ID` |

**工具映射**（4 个工具对齐 v3）：

| MCP 工具 | v3 端点 | 说明 |
| ---- | ---- | ---- |
| `recall_memory` | `/v3/atomic/search` + `/v3/scenario/ls` + `/v3/core/read` | 多层级召回（L1+L2+L3），结果按相关度合并 |
| `store_memory` | `/v3/conversation/add` | L0 显式写入（isolation 三元组必填） |
| `search_memories` | `/v3/atomic/search` | L1 语义搜索 |
| `end_session` | `/v3/session/*` | 会话管理 |

**鉴权**：`Authorization: Bearer <apiKey>` + `x-tdai-service-id` + 请求体隔离三元组。

---

## 7. API 端点对照表（旧 vs 新）

| 旧 (bridge-server) | 新 (团队版) | 自动注入 | 显式调用 | 说明 |
| ---- | ---- | ---- | ---- | ---- |
| `/api/v1/recall` | MemoryProxy 注入 + 工具召回 | ✅ L2/L3 注入 system prompt | ✅ L1 `/v3/atomic/search`、L0 `/v3/conversation/search`（经 `<tdai_memory_tools>`） | L2/L3 由 proxy 自动注入；需主动查 L1/L0 时经工具 |
| `/api/v1/capture` | `/v3/conversation/add`（L0） | ✅ MemoryProxy 透明回流 | ✅ mcp-bridge `store_memory` | 显式或透明二选一 |
| `/api/v1/search/memories` | `/v3/atomic/search` | — | ✅ L1 语义搜索 | mcp-bridge `search_memories` |
| `/api/v1/search/conversations` | `/v3/conversation/search` | — | ✅ L0 对话搜索 | mcp-bridge 或工具 |
| `/api/v1/session/end` | `/v3/session/*` | — | ✅ 会话管理 | 由 proxy/核心负责 |

---

## 8. 管理分配（Memory Hub 操作清单）

1. 建 **1 个团队** `my-workspace`，把自己加为成员
2. 建 **平台级 agents**：`claude-code` / `openclaw` / `workbuddy`（一个平台一个，不按项目拆）
3. **项目资产**（Wiki / CodeGraph / Skill）绑定到 `my-workspace`，用 **agent 可见性 / ACL** 控制哪个项目的资产配给哪个 agent
4. 默认值：`user_id=me` 统一；`team_id=my-workspace` 统一；`agent_id` 按平台；`task_id` 每次会话动态

---

## 9. 隔离矩阵

| 场景 | team | agent | user | 是否隔离 |
| ---- | ---- | ---- | ---- | ---- |
| Claude Code 在项目 A | my-workspace | claude-code | me | 与项目 B 共享（A1 预期） |
| 跨 agent 借入 | 同 team | 借入 ≤2 | 各自 | 同团队内允许 |
| 客户项目 | client-X（独立 team） | 平台 agent | me | ✅ 硬隔离 |
| Server Agent 运维 | 系统账号 | 短路透传 | 不入用户域 | ✅ 不写 L0/L1 |

---

## 10. 迁移步骤（v0.2 当前代码 → 团队版）

1. **服务端**：部署团队版三件套（MemoryCore + MemoryHub + MemoryProxy），用 `deploy/global-images/start-all.sh` 一键拉起
2. **Hub 供给**：建单团队 `my-workspace` + 平台 agents（`claude-code` / `openclaw` / `workbuddy`），把用户 `me` 加为成员
3. **Claude Code → MemoryProxy**：`setup-claude-code.sh` 写 `ANTHROPIC_BASE_URL` + 身份 header（`x-team-id` / `x-agent-id`）
4. **WorkBuddy → MemoryProxy**：模型 URL 指到 `/v1/chat/completions` 端点
5. **OpenClaw → 官方 openclaw-plugin**：安装 + 静态配置三元组（teamId/agentId/userId）
6. **mcp-bridge → 重写对齐 v3**：直连 `/v3/*` + 官方 SDK，配置升级为三元组（§6.5）
7. **退役 bridge-server**：停止部署；MCP 配置移除 `BRIDGE_URL` 指向
8. **旧数据**：服务器团队版若为全新实例，旧 sender 数据需用上游迁移工具（`migrate-v2-to-v3`）或接受历史不迁移
9. **简化 CLAUDE.md auto-store**：改由 MemoryProxy 透明回流，删除显式 `store_memory` 规则

---

## 11. 待定问题 / 下一步

- [ ] mcp-bridge v3 重写的实现计划（§6.5 细化）
- [ ] Server Agent 调度脚本初版（建 team/agent、资产导入）
- [ ] Claude Code / WorkBuddy / OpenClaw 三平台接入验证
- [ ] 旧数据迁移决策（迁移工具 vs 历史不迁移）
- [ ] CLAUDE.md auto-store 规则简化落地
