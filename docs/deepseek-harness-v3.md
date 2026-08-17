# DeepSeek Harness 接入指南（mcp-bridge v3）

> **版本**: 0.4.0 · DeepSeek Harness（DSH）接入团队版记忆（MemoryCore `/v3/*`）
> **接入方式**: DSH 原生 MCP 客户端（`@deepseek-ai/dsh-mcp-client`）→ 本项目 `mcp-bridge`（stdio）→ MemoryCore `/v3/*`

## 概述

DeepSeek Harness（dsh）原生支持 MCP 客户端：在 DSH profile 的 `cordis.yml`（实际编辑 patch 层 `cordis.patch.yml`）里注册 `@deepseek-ai/dsh-mcp-client` 插件，即可把外部 MCP 服务器（本项目的 `tencent-agent-memory-mcp-bridge`）的工具注册为原生工具 `mcp__agent-memory__recall_memory` 等。

| 能力 | 说明 |
| --- | --- |
| 工具命名 | `mcp__<serverName>__<rawName>`，如 `mcp__agent-memory__recall_memory` |
| 召回 | L1 项目内语义搜索 + L3 persona + L2 场景索引（`recall_memory` / `search_memories`） |
| 写入 | 显式调用 `store_memory` 写 L0（DSH 无 Claude Code 式 Stop hook，写入由模型按需调用） |
| 热更新 | 编辑 `cordis.patch.yml` 触发 HMR（断开 + 重连），无需重启 DSH |
| 隔离 | team/agent/user 三元组 + `task_id` 项目级标签，全部由 MCP env 注入，模型不可改 |

> **为什么不用 MemoryProxy？** MemoryProxy 是"透明 LLM 代理"，需要把 DSH 的 LLM baseURL 指到 MemoryProxy（`/v1/chat/completions`）。DSH 的模型走官方 DeepSeek API（`deepseek-official`），改 baseURL 会侵入 LLM 接入层、影响模型可用性。MCP 路线零侵入、DSH 原生支持，是首选。

## 配置

### 1. 安装 mcp-bridge（任意一种）

```bash
# 全局安装（推荐，npx 命中最新版）
npm install -g tencent-agent-memory-mcp-bridge@latest
```

### 2. 在 DSH profile 注册 MCP 服务器

找到 DSH profile 配置（Windows 默认 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），追加：

> ⚠️ **必须用 `- insert:` 追加新条目**：cordis patch 层里，不带 insert 的 `- id: <x>`
> 是"覆盖已有行"语义——目标行不存在会被静默跳过（工具不出现）。insert 不带 id
> 才表示向顶层条目列表追加新插件行。

```yaml
- insert:
    - id: mcp-agent-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory
        transport: stdio
        command: npx
        args: ['-y', 'tencent-agent-memory-mcp-bridge']
        env:
          MEMORY_ENDPOINT: https://memory.kuai-private.top
          API_KEY: '<gate-api-key>'
          SERVICE_ID: default
          TEAM_ID: '<team-id>'
          AGENT_ID: '<deepseek-harness-agent-id>'
          USER_ID: '<user-id>'
          USER_KEY: '<deepseek-harness-user-key>'
        toolCallTimeoutMs: 30000
```

模板见 [`examples/deepseek-harness/cordis.patch.yml`](../examples/deepseek-harness/cordis.patch.yml)。

| 配置项 | 必填 | 说明 |
| --- | --- | --- |
| `serverName` | ✅ | 工具命名空间（`mcp__agent-memory__*`），存活实例中唯一 |
| `command` / `args` | ✅ | stdio 启动 `npx -y tencent-agent-memory-mcp-bridge` |
| `env.MEMORY_ENDPOINT` | ✅ | MemoryCore Gateway 地址 |
| `env.API_KEY` | ✅ | 网关门禁 key（Bearer，多 agent 共用） |
| `env.SERVICE_ID` | ✅ | spaceId（`x-tdai-service-id`），如 `default` |
| `env.TEAM_ID` | ✅ | 团队 id（`team-*`） |
| `env.AGENT_ID` | ✅ | **deepseek-harness 的 agent id（`agt-*`）**——每平台一个，区别于 claude-code / codebuddy / openclaw |
| `env.USER_ID` | ✅ | 用户 id（`usr-*`） |
| `env.USER_KEY` | ❌ | deepseek-harness 的 `sk-mem-*`（meta 面鉴权用，可选） |
| `env.TASK_ID` | ❌ | 项目级隔离标签；**不设则从 MCP 子进程 cwd 自动派生（项目目录名）** |

> ⚠️ `API_KEY` / `USER_KEY` 是真实密钥：**只放本机**（`cordis.patch.yml` 在用户目录）或环境变量，不进仓库。

### 3. task_id（项目级隔离，与身份严格分离）

| 概念 | 取值 | 含义 |
| --- | --- | --- |
| `agent_id` | `agt-25k8snomqe` | **平台身份**：deepseek-harness 的隔离身份，跨项目不变 |
| `team_id` / `user_id` | `team-*` / `usr-*` | 团队 / 人类用户，跨项目不变 |
| `task_id` | 项目名（如 `TencentAgentMemoryBridge`） | **项目级隔离标签**：本项目的事实只在 `task_id` 内召回 |

- **自动派生**：`TASK_ID` 未设时，mcp-bridge 读 `process.cwd()`（DSH spawn 子进程的工作目录）取目录名。DSH 多项目会话共用同一 profile 时，建议**显式设置 `TASK_ID`**（`cordis.patch.yml` 的 `env.TASK_ID`，或 `!!js process.env.TASK_ID` 从 DSH 进程环境注入），避免所有项目派生到同一个目录名。
- **防混用**：mcp-bridge ≥ 0.4.0 在启动时拒绝 `agt-` / `team-` / `usr-` / `uky-` / `sk-` / `key-` 前缀的 `task_id`——**绝不能把 `AGENT_ID` 等身份 id 填进 `TASK_ID`**（否则所有项目共享同一个"task"，项目级隔离失效）。
- L1 事实按 `task_id` 隔离；L3 persona / L2 场景仍按 team+agent 维度跨项目共享。

## 使用

模型看到的工具（DSH 注册为原生工具，携带服务器提供的描述与 schema）：

| 工具 | 功能 | 注意 |
| --- | --- | --- |
| `mcp__agent-memory__recall_memory` | 多层级召回（L1 facts + L3 persona + 可选 L2 scenes） | 结果含 `_context`（当前 team/agent/user/task） |
| `mcp__agent-memory__store_memory` | 写 L0（user_content + assistant_content） | 结果含 `_context` |
| `mcp__agent-memory__search_memories` | L1 语义搜索 | 结果含 `_context` |

> 工具**不接受** `agent_id` / `task_id` 参数——身份与项目标签由 MCP env 注入，模型只需调用，不要猜测或混用。`_context` 回显让模型/用户明确看到当前调用落在哪个 (team, agent, user, task) 域。

## 自动入库（默认提交、按需取回）

DSH 没有 Claude Code 式 Stop hook，用独立守护脚本实现"每轮对话完成后自动提交"：

```bash
# 部署：一次性建立基线（跳过当前历史轮次，不回溯提交）
node scripts/dsh-memory-autostore.mjs --baseline-only

# 增量提交一次（配合 Windows 计划任务，每 N 分钟跑一次，只提交新完成的轮次）
node scripts/dsh-memory-autostore.mjs --once

# Windows 计划任务静默版（推荐）：wscript 隐藏窗口执行，无 cmd 闪烁，
# 输出追加到 scripts/dsh-memory-autostore-run.log
wscript.exe scripts\dsh-memory-autostore-hidden.vbs

# 或常驻守护（10 秒轮询，延迟更低）
node scripts/dsh-memory-autostore.mjs

# 其他选项
node scripts/dsh-memory-autostore.mjs --backfill   # 补提交历史全部轮次
node scripts/dsh-memory-autostore.mjs --dry-run    # 只扫描打印，不提交
```

工作原理：

- 扫描 `~/.dsh/sessions/**/session.jsonl.zstd`（DSH 会话日志，zstd 多帧 JSONL，Node 24 内置 `node:zlib` 解压，零额外依赖）
- 每个回合结束（`turn/end` 事件）自动提取该轮 user 文本（`source.kind==='user'`，排除系统注入）+ assistant 最终文本，POST 到 `/v3/conversation/add`
- **身份**：team/agent/user + 门禁 key 复用 DSH 本机配置 `~/.dsh/profiles/web/cordis.patch.yml` → `mcp-agent-memory.env`（单一事实源），支持环境变量覆盖
- **task_id**：从会话 header 的 `cwd` 自动派生（项目目录名），每项目独立；与 `agent_id` 严格分离
- **去重**：按 `session_id + turn` 写 `~/.dsh/.dsh-memory-autostore-state.json`；守护启动时把现有轮次记为基线（不回溯提交历史），只提交之后新增的轮次；子代理（subagent）会话跳过
- 提交失败只记 stderr、游标不推进，下次轮询自动重试

## 验证

1. 保存 `cordis.patch.yml` 后，DSH 日志应出现 MCP 连接成功；工具列表应出现 `mcp__agent-memory__*`（新会话生效）。
2. 调用 `mcp__agent-memory__store_memory` 存一条测试消息 → 返回 `accepted_ids` 且 `_context.task_id` 等于期望的项目名、`_context.agent_id` 是 deepseek-harness 的 `agt-*`。
3. 稍候（L1 后台抽取）调用 `mcp__agent-memory__recall_memory` 搜刚才的内容 → 应能召回。

## 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 工具列表没有 `mcp__agent-memory__*` | MCP 未连上 / 版本旧 | 检查 `command`/`args`、env 是否完整；`npm ls -g tencent-agent-memory-mcp-bridge` 确认 ≥ 0.4.0 |
| DSH 日志报 `Invalid task_id ... must NOT be an identity id` | `TASK_ID` 误填了身份 id（agt-/team-/usr-/sk-） | 把 `TASK_ID` 改成项目名，或删掉让它从 cwd 派生 |
| `401 Unauthorized` | 门禁 key 不对或过期 | 核对 `API_KEY` |
| `_context` 里 `task_id` 不是预期项目 | DSH 多项目共用 profile，cwd 派生固定 | 显式设置 `env.TASK_ID`（或 `!!js process.env.TASK_ID`） |
| 连接后崩溃循环 | mcp-bridge 启动即抛错（如 task_id 校验失败） | 修 env 后重试；`reconnect.maxAttempts` 控制重连预算 |
