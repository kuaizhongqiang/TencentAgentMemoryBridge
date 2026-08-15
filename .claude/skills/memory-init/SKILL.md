---
name: memory-init
description: 初始化/打通/修复当前项目的 TencentDB Agent Memory 接入。当用户把 TencentAgentMemoryBridge 的 .claude 文件夹复制到新项目、或说"初始化记忆 / 初始化 task / memory init / 接入记忆"时使用——校验 MCP 配置、按目录名派生 task_id（与 agent_id 严格分离，拒绝 agt-/team-/usr- 等身份 id 作 task_id）、健康检查网关、修复缺失的 Stop hook 脚本。
---

# memory-init

把当前项目接入 TencentDB Agent Memory（团队版 v3）。典型场景：把 TencentAgentMemoryBridge 的 `.claude` 文件夹整体复制到新项目后，执行本 skill，让该项目的 Claude Code 能正确按项目级 `task_id` 隔离记忆。

## 身份 vs 项目（必须先分清，禁止混用）

| 概念 | 配置项 | 取值形态 | 含义 | 是否随项目变 |
| --- | --- | --- | --- | --- |
| 平台身份 | `AGENT_ID` | `agt-xxx` | 本 agent（claude-code）的隔离身份，meta 面注册实体 | ❌ 跨项目不变 |
| 团队 | `TEAM_ID` | `team-xxx` | 所属团队 | ❌ 跨项目不变 |
| 用户 | `USER_ID` | `usr-xxx` | 唯一人类用户 | ❌ 跨项目不变 |
| **项目标签** | `TASK_ID` | 项目名（如 `TencentAgentMemoryBridge`） | **项目级隔离标签**，自由字符串 | ✅ 每项目不同 |

> ⚠️ **`task_id` 绝不等于/不来自任何身份 id**：不要用 `AGT_ID`/`TEAM_ID`/`USER_ID`/key 当 `task_id`（mcp-bridge ≥0.4.0 会拒绝 `agt-`/`team-`/`usr-`/`sk-` 前缀并报错）。`task_id` 的取值是"这个项目叫什么"，身份是"我是谁"——两码事。

## 前置

- `.claude/settings.local.json` 已含 `mcpServers.agent-memory`（随 `.claude` 一起拷贝过来）
- 本 skill 目录自带两个脚本（随 `.claude` 拷贝）：
  - `scripts/init.mjs` — 初始化主脚本
  - `scripts/stop-memory-store.mjs` — Stop hook 自动入库脚本（种子，用于补回缺失副本）

## 步骤

1. 在项目根目录运行初始化脚本：

   ```bash
   node .claude/skills/memory-init/scripts/init.mjs
   ```

2. 读取输出，逐项核对：
   - `config.required` / `gateway.read` / `gateway.auth` 是否 ✅
   - `task_id` 是否等于期望的项目目录名（且**不是** agt-/team-/usr- 开头的身份 id）
   - `Stop hook` 状态：`存在` / `已补写` / `修复: <路径>`

3. 出现 ❌ 项时按提示处理：
   - **缺失配置 / 疑似占位符** → 补全 `.claude/settings.local.json` → `mcpServers.agent-memory.env` 的 `MEMORY_ENDPOINT` / `API_KEY` / `SERVICE_ID` / `TEAM_ID` / `AGENT_ID` / `USER_ID`
   - **task_id 校验 ❌**（身份前缀）→ 清掉 `TASK_ID` 环境变量或改成项目名；**绝不能把 `AGT_ID` 之类身份 id 填进 `TASK_ID`**
   - **网关不可达**（`gateway.read` ❌）→ 检查 `MEMORY_ENDPOINT` 与网络
   - **`hook.script` ❌ 且无种子可补** → 说明 `.claude` 复制不完整，需从原项目重新复制

4. （可选）验证写路径会往 L0 留一条 bootstrap 标记，默认不做：

   ```bash
   node .claude/skills/memory-init/scripts/init.mjs --verify-write
   ```

5. 向用户汇报结果：身份、task_id、网关状态、Stop hook 是否已修复，以及下一步。汇报时**分开说**：`agent_id=agt-xxx（平台身份，跨项目不变）`、`task_id=<项目名>（本项目）`，不要混为一谈。

## 关键事实（汇报与排障时引用）

- **task_id = 项目目录名**（与 mcp-bridge `deriveTaskIdFromCwd` 一致，自动派生实现项目级记忆隔离）；可用 `TASK_ID` 环境变量覆盖，但值必须是项目名，**身份 id（agt-/team-/usr-/sk- 前缀）会被拒绝**
- **身份单一事实源**：`.claude/settings.local.json` → `mcpServers.agent-memory.env`（team/agent/user + Bearer key + 可选 `USER_KEY`）；claude-code 的 agent_id 跨项目不变
- **MemoryCore 没有 task 实体创建 API（数据面）**：task_id 是数据面字符串标签，`conversation/add` 携带即用，无需注册；meta 面 `/v3/meta/task/*` 是另一回事（管理端）
- **Stop hook 自愈**：引用的 `scripts/stop-memory-store.mjs` 缺失时从 skill 种子补回；`hooks.Stop` 缺失时自动补写；state 文件加入 `.gitignore`
- 每轮对话结束后 Stop hook 自动写入 L0（按 `session_id` + 时间戳去重）；`recall_memory` / `search_memories` 按需调用，绝不自动
