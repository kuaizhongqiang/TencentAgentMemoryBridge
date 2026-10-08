# Octop 接入指南（mcp-bridge v3）

> **版本**: 0.5.0 · Octop（agent harness）接入团队版记忆（MemoryCore `/v3/*`）
> **接入方式**: Octop 原生 **自定义 MCP 连接器**（stdio）→ 本项目 `mcp-bridge` → MemoryCore `/v3/*`；入库由独立守护脚本 `scripts/octop-memory-autostore.mjs` 兜底

## 概述

[Octop](https://github.com/) 是一套自托管 agent harness：一个进程里跑「Agent + 通道（Dashboard / 微信 / 飞书…）+ 定时任务 + MCP 连接器」。它的 MCP 支持是**一等公民**——连接器在 Dashboard 里注册，工具按会话注入，因此接记忆**零侵入**：不改模型接入层、不改 harness 代码。

| 能力 | 说明 |
| --- | --- |
| 工具命名 | Octop 给 MCP 工具加服务器名前缀，如 `agent-memory_recall_memory`（前缀 = 连接器里注册的 server 名） |
| 召回 | L1 项目内语义搜索（`recall_memory` / `search_memories`）+ L0 原始对话检索（`search_conversations`） |
| 写入 | 显式 `store_memory` 写 L0；**默认由守护脚本按轮次自动提交**（见 §4） |
| 隔离 | team/agent/user + `task_id`，全部由连接器 env 注入，模型不可改 |
| 生效范围 | 连接器开 `default_open` 后，Dashboard / IM / Cron 的每一轮都自动带工具（Dashboard 可在输入框里关掉本轮） |

> **为什么不用 MemoryProxy？** MemoryProxy 是"透明 LLM 代理"，要把 Octop 的 provider baseURL 指过去。Octop 的模型走官方 API，改 baseURL 会侵入 LLM 接入层、影响所有 Agent 的可用性。**MCP 连接器路线零侵入**，是首选。

---

## 1. 在 MemoryCore 里供给一个 agent 身份（一次性）

每个接入平台一个 agent 身份（与 `deepseek-harness` / `claude-code` / `codebuddy` 并列）。用 `user_key` 打 meta 面：

```bash
curl -s -X POST http://127.0.0.1:8422/v3/meta/agent/create \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -H 'x-tdai-service-id: default' \
  -H "x-tdai-user-key: $USER_KEY" \
  -d '{"team_id":"<team-id>","owner_user_id":"<user-id>","name":"octop","description":"octop agent (Octop harness) for kuai","visibility":"team"}'
# → data.agent_id = "agt-xxxxxxxxxx"
```

校验：`POST /v3/meta/agent/list {"team_id":"<team-id>"}` 应能看到 `octop`。

---

## 2. 注册自定义 MCP 连接器

Dashboard：**设置 → 连接器 → 自定义 MCP → 新增**，或直接调 API：

```bash
curl -s -X PUT http://127.0.0.1:8088/api/connectors/custom-mcp \
  -H "Authorization: Bearer $OCTOP_JWT" -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "servers": {
    "agent-memory": {
      "transport": "stdio",
      "command": "node",
      "args": ["<npm 全局目录>/tencent-agent-memory-mcp-bridge/dist/index.js"],
      "env": {
        "MEMORY_ENDPOINT": "http://127.0.0.1:8422",
        "API_KEY": "<gate-api-key>",
        "SERVICE_ID": "default",
        "TEAM_ID": "<team-id>",
        "AGENT_ID": "<octop-agent-id>",
        "USER_ID": "<user-id>",
        "USER_KEY": "<octop-user-key>",
        "TASK_ID": "octop"
      },
      "display_name": "TencentDB Agent Memory (腾讯记忆)",
      "enabled": true,
      "default_open": true
    }
  }
}
JSON
```

模板见 [`examples/octop/custom-mcp.json`](../examples/octop/custom-mcp.json)。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `transport` | ✅ | `stdio`（本机进程）或 `streamable_http`（远程 URL） |
| `command` / `args` | ✅ | stdio 启动命令。`npx -y tencent-agent-memory-mcp-bridge` 亦可，但**全局装 + 绝对路径**启动更稳（不依赖每轮拉包） |
| `env.*` | ✅ | mcp-bridge 的隔离三元组 + 门禁 key，见 [mcp-bridge v3 配置](mcp-bridge-v3.md#环境变量) |
| `enabled` | ✅ | 关掉即整条连接器下线 |
| `default_open` | ⭐ | **开** → Dashboard / IM / Cron 默认都带这组工具；关 → 每轮需在输入框手动勾选 |

> ⚠️ **stdio MCP 只继承最小环境**（`HOME/PATH/USER/...`），不继承 harness 进程的完整 env。所有凭据**必须写进 `env`**，靠 `~/.bashrc` 里的 export 是不生效的。

装包：

```bash
npm install -g --prefix "$HOME/.npm-global" tencent-agent-memory-mcp-bridge@latest
# dist: $HOME/.npm-global/lib/node_modules/tencent-agent-memory-mcp-bridge/dist/index.js
```

改动后让 Agent 重新加载：

```bash
curl -s -X POST http://127.0.0.1:8088/api/agents/<agent_id>/reload -H "Authorization: Bearer $OCTOP_JWT" -i
# 或 Dashboard 里改连接器（会自动触发 reload）
```

自检（探活 + 列工具）：

```bash
curl -s -X POST http://127.0.0.1:8088/api/connectors/custom-mcp/test \
  -H "Authorization: Bearer $OCTOP_JWT" -H 'Content-Type: application/json' \
  -d '{"name":"agent-memory"}'
# → {"ok":true,"tool_count":4,"tools":[...]}
```

---

## 3. task_id（项目级隔离，与身份严格分离）

| 概念 | 取值 | 含义 |
| --- | --- | --- |
| `agent_id` | `agt-xxxxxxxxxx` | **平台身份**：octop 的隔离身份，跨项目不变 |
| `team_id` / `user_id` | `team-*` / `usr-*` | 团队 / 人类用户，跨项目不变 |
| `task_id` | `octop`（本工作区标签） | **项目级标签**：该标签下的事实自成一片 |

- Octop 是「一个 Agent 一个工作区」，没有 DSH 那种「每项目一个 cwd」，所以 **`TASK_ID` 建议显式写死**（如 `octop`），别指望从 cwd 派生。
- **防混用**：mcp-bridge ≥ 0.4.0 启动即拒绝 `agt-` / `team-` / `usr-` / `uky-` / `sk-` / `key-` 前缀的 `TASK_ID`——绝不能把 `AGENT_ID` 填进 `TASK_ID`。
- L1 事实按 `task_id` 隔离；L3 persona / L2 场景按 team+agent 维度跨项目共享。

---

## 4. 自动入库（默认提交、按需取回）

Octop 没有 Stop hook，`store_memory` 也只有模型显式调用才写。用独立守护脚本补上：

```bash
# 部署：一次性建基线（跳过现有历史，不回溯提交）
node scripts/octop-memory-autostore.mjs --baseline-only

# 增量提交一次（配 systemd timer / cron，每 N 分钟跑一次）
node scripts/octop-memory-autostore.mjs --once

# 或常驻守护（10s 轮询，延迟更低）
node scripts/octop-memory-autostore.mjs

# 其他
node scripts/octop-memory-autostore.mjs --backfill   # 补提交历史全部轮次
node scripts/octop-memory-autostore.mjs --dry-run    # 只扫描打印
```

工作原理：

- 读 Octop 主库 **`~/.octop/octop.db`（SQLite，只读连接）** 的 `thread_messages` + `threads`——DSH 版读会话日志，Octop 版读 SQLite，语义相同
- 「用户一轮 → 助手**最终**回复」配对成一只 turn（中间过程 ai/tool 消息不算），POST 到 `/v3/conversation/add`
- **身份**：env 优先，其次 `MEMORY_CONFIG`（默认 `~/.config/octop-memory/agent-memory.json`，**chmod 600**）
- **session_id**：默认取 `threads.session_key`（如 `main:dashboard:1:dm`），同一通道的多个 thread 视作一段连续会话；`OCTOP_AUTOSTORE_SESSION_MODE=thread` 可改成"一对话一 session"
- **task_id**：`TASK_ID`（默认 `octop`）
- **去重**：按 `thread_id` 记游标（最后提交的 assistant seq），写 `~/.octop/.octop-memory-autostore-state.json`；提交失败**不推进游标**，下次自动重试
- **并发保护**：`state.json.lock` 进程锁，守护 + 计划任务同时跑也不会重复入库
- 只依赖 Node ≥ 22.5 的 `node:sqlite`，**零 npm 依赖**

### systemd 用户级部署（推荐）

```bash
cp examples/octop/octop-memory-autostore.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now octop-memory-autostore.service
journalctl --user -u octop-memory-autostore -f
```

凭据文件（**不要提交**）：

```bash
install -d -m700 ~/.config/octop-memory
install -m600 /dev/null ~/.config/octop-memory/agent-memory.json
cat > ~/.config/octop-memory/agent-memory.json <<'JSON'
{
  "MEMORY_ENDPOINT": "http://127.0.0.1:8422",
  "API_KEY": "<gate-api-key>",
  "SERVICE_ID": "default",
  "TEAM_ID": "<team-id>",
  "AGENT_ID": "<octop-agent-id>",
  "USER_ID": "<user-id>",
  "TASK_ID": "octop"
}
JSON
```

---

## 5. 使用

模型看到的工具（Octop 注册为 `<server>_<tool>`）：

| 工具 | 功能 | 注意 |
| --- | --- | --- |
| `agent-memory_recall_memory` | 多层级召回（L1 facts + L3 persona + 可选 L2 scenes） | 结果含 `_context`（当前 team/agent/user/task） |
| `agent-memory_store_memory` | 写 L0（user_content + assistant_content） | 守护脚本已兜底，一般无需显式调 |
| `agent-memory_search_memories` | L1 语义搜索 | L1 抽取是异步的，刚说过的内容可能还没进事实索引 |
| `agent-memory_search_conversations` | L0 原始对话检索（≥0.5.0） | 默认跨 session；传 `session_key` 才限定单会话 |

> 工具**不接受** `agent_id` / `task_id` 参数——身份与项目标签由连接器 env 注入。`_context` 回显让模型/用户明确看到当前调用落在哪个 (team, agent, user, task) 域。

---

## 6. 验证

1. `POST /api/connectors/custom-mcp/test {"name":"agent-memory"}` → `ok: true`，工具数 ≥ 3。
2. `POST /api/agents/<agent_id>/reload` 后，在 Dashboard 发一句话让 Agent 调 `search_memories`，结果里的 `_context.agent_id` 应是 octop 的身份。
3. 回一句话 → 等 ≤10s（或 `--once` 手动触发）→ `POST /v3/conversation/count` 带隔离三元组 + `TASK_ID`，`total` 应增加。
4. 再等 L1 抽取（阈值：每 5 轮 / 会话空闲 600s）→ `POST /v3/atomic/search` 搜刚才的内容应能召回；在此之前可用 `search_conversations` 直接从 L0 捞。

---

## 7. 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 模型看不到记忆工具 | 连接器没 `default_open`，且本轮没在输入框勾选 | 打开 `default_open`；或每轮手动勾选；IM 通道走默认值，无需勾选 |
| 连接器探活失败 | `command`/`args` 路径不对，或 `node` 不在 MCP 子进程 PATH 里 | 用绝对路径启动；`PATH` 只继承 harness 进程的 PATH |
| `401 Unauthorized` | `API_KEY` 不对/过期 | 核对门禁 key |
| `Invalid task_id ... must NOT be an identity id` | `TASK_ID` 误填身份 id | 改成项目名（如 `octop`） |
| 召回为空，但确实说过 | L1 抽取是异步的（每 5 轮 / 空闲 600s） | 用 `search_conversations` 读 L0；或等一轮 |
| 守护脚本报 `需要 Node ≥ 22.5 的 node:sqlite` | Node 版本太低，或 Node 22 没带 `--experimental-sqlite` | 升级到 Node ≥ 23，或用 Node 24 |
| 守护报 `已有实例在运行` | 前一个实例没退干净（锁文件残留） | 确认无进程后删 `~/.octop/.octop-memory-autostore-state.json.lock` |
| 同一轮被提交两次 | 手动跑了 `--once` 又跑了守护，但游标被删 | 不要删 state 文件；锁文件保证并发安全 |
