# Claude Code 快速配置

部署此桥接服务的完整指南。

---

## 1. 基础 MCP 服务器配置

在 `.claude/settings.json` 或 `~/.claude/settings.json` 中注册 MCP 服务器：

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["tencent-agent-memory-mcp-bridge"],
      "env": {
        "BRIDGE_URL": "https://your-server.com/api/v1",
        "API_KEY": "sk-your-api-key",
        "SENDER": "claude-code"
      }
    }
  }
}
```

### 环境变量说明

| 变量 | 说明 |
|------|------|
| `BRIDGE_URL` | Bridge Server 公网地址 |
| `API_KEY` | 分配给 Claude Code 的 API 密钥 |
| `SENDER` | 代理标识，固定为 `claude-code` |

> 各 agent 的 `SENDER` 不同（CodeBuddy = `codebuddy`，OpenClaw = `openclaw`），Server 端以此**隔离记忆域**，确保 coding 和日常对话互不干扰。

### 记忆域隔离原理

每个 sender 拥有独立的记忆域：

| Sender | 用途 | 记忆域 | 跨域搜索 |
| ------ | ---- | ------ | -------- |
| `claude-code` | 编码分析 | 仅自己的对话 | ❌ |
| `codebuddy` | 编码调试 | 仅自己的对话 | ❌ |
| `openclaw` | 日常对话 | 仅自己的对话 | ✅ 通过复杂命令 |

- **capture 时**：bridge-server 自动将 `X-Sender` 写入转发到上游的请求体中，存储层按 sender 标记
- **recall 时**（MCP 工具）：自动仅召回本 sender 域的记忆，MCP 工具**不暴露** `sender` 参数
- **recall 时**（HTTP API）：可通过请求体加 `sender` / `senders` 指定过滤，跨域需 `crossDomainRecall` 权限
- **openclaw-plugin** 已自动在 recall 时带上自己的 sender，无需手动配置

---

## 2. Auto-Store 行为（CLAUDE.md 定义）

项目根目录的 [CLAUDE.md](../../CLAUDE.md) 已定义以下规则，**任何打开此项目的 Claude Code 实例都会自动遵守**：

### 每次回复后自动存储

```text
store_memory(
  user_content:      "<用户本轮输入>",
  assistant_content: "<你这轮的回复>",
  session_key:       "claude-code-tencent-agent-memory-bridge-{YYYY-MM-DD}"
)
```

由 Claude 在每次回复结束时主动调用（[Stop hook 拿不到对话内容](Hooks 文档链接)）。

### 按需回忆（永不自动）

`recall_memory` 仅在以下情况调用：

- 需要之前对话的历史上下文
- 用户询问长期记忆中可能存在的偏好或历史
- 不确定项目相关决策记录

### Session Key 格式

```
claude-code-tencent-agent-memory-bridge-{YYYY-MM-DD}
```

每天一个 session，同一 session 内所有轮次自动关联。

---

## 3. (可选) Stop Hook 配置

如果想在每次 Claude 停止时额外标记 session 活跃，在 `.claude/settings.local.json` 中添加：

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "mcp_tool",
        "server": "agent-memory",
        "tool": "end_session"
      }]
    }]
  }
}
```

**注意**：替换 `{YYYY-MM-DD}` 为当天日期。如果不传 `session_key`，服务端会自动用 `{sender}-{timestamp}` 生成。

---

## 4. 验证是否生效

在 Claude Code 中测试：

```
你：测试一下记忆系统是否正常
Claude：（回复后自动调用 store_memory）

你：刚才我们聊了什么？
Claude：（按需调用 recall_memory 获取上下文）
```

或手动测试：

```bash
# Recall（不指定 sender = 召回全部域）
curl -X POST https://your-server.com/api/v1/recall \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "X-Sender: claude-code" \
  -H "Content-Type: application/json" \
  -d '{"query": "测试查询"}'

# Recall（指定 sender = 只召回 claude-code 域的记忆）
curl -X POST https://your-server.com/api/v1/recall \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "X-Sender: claude-code" \
  -H "Content-Type: application/json" \
  -d '{"query": "测试查询", "sender": "claude-code"}'

# Recall（指定多个 sender）
curl -X POST https://your-server.com/api/v1/recall \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "X-Sender: claude-code" \
  -H "Content-Type: application/json" \
  -d '{"query": "测试查询", "senders": ["claude-code", "codebuddy"]}'

# Capture（sender 自动注入，无需手动传）
curl -X POST https://your-server.com/api/v1/capture \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "X-Sender: claude-code" \
  -H "Content-Type: application/json" \
  -d '{"user_content": "你好", "assistant_content": "你好！", "session_key": "test-session"}'
```

---

## 配置清单

- [ ] MCP 服务器已注册（`settings.json`）
- [ ] `BRIDGE_URL` / `API_KEY` / `SENDER` 已填写
- [ ] `CLAUDE.md` 已包含 Auto Memory Store 章节
- [ ] (可选) `Stop hook` 已配置
- [ ] 已用 curl 验证桥接服务可达
