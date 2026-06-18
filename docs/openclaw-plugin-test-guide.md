# OpenClaw 插件测试指南

**仓库地址**：https://github.com/kuaizhongqiang/TencentAgentMemoryBridge

---

## 测试目标

验证 `openclaw-plugin` 的三个生命周期钩子是否能正确连接 bridge-server，并正确转发数据到 TencentDB Agent Memory。

## 测试环境准备

### 1. bridge-server

启动 bridge-server：

```bash
git clone https://github.com/kuaizhongqiang/TencentAgentMemoryBridge.git
cd TencentAgentMemoryBridge
pnpm install
cd packages/bridge-server
pnpm dev
```

环境变量配置（`packages/bridge-server/.env`）：

```bash
PORT=3000
TENCENTDB_URL=http://localhost:8080

# 临时测试用——允许任何 sender
AGENTS=[{"name":"openclaw","apiKeyHash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","allowedEndpoints":["*"]}]
```

> `apiKeyHash` 是 `test` 的 sha256，测试时 API_KEY 填 `test` 即可。

### 2. 插件配置

```jsonc
// openclaw.json
{
  "memory-bridge": {
    "enabled": true,
    "config": {
      "bridgeUrl": "http://localhost:3000/api/v1",
      "apiKey": "test",
      "sender": "openclaw",
      "sessionKey": "test-session-001"
    }
  }
}
```

## 测试用例

### 测试 1：before_prompt_build → recall

**预期**：Agent 生成回复前，插件调用 `POST /api/v1/recall`。

**验证**：
- bridge-server 日志有 `/api/v1/recall` 请求，sender=openclaw
- 请求体包含 `query` 和 `session_key`

### 测试 2：agent_end → capture

**预期**：每次 Agent 回复后，插件调用 `POST /api/v1/capture`。

**验证**：
- bridge-server 日志有 `/api/v1/capture` 请求
- 请求体包含 `user_content`、`assistant_content`、`session_key`

### 测试 3：session_end → session/end

**预期**：会话结束时调用 `POST /api/v1/session/end`。

**验证**：bridge-server 日志有请求记录。

### 测试 4：bridge-server 不可用时降级

**预期**：bridge-server 没启动时，Agent 对话不受影响。

**验证**：
- 不启动 bridge-server，正常使用 Agent
- Agent 正常回复，日志出现 `[memory-bridge] recall failed (silent):`

### 测试 5：认证失败时降级

**预期**：apiKey 填错时，Agent 正常回复。

**验证**：故意填错 apiKey，Agent 不报错中断。

### 测试 6：session_key 自动生成

**预期**：不传 `sessionKey` 时自动生成 `openclaw-xxxxxxxx` 格式的 key。

**验证**：注释掉 `sessionKey` 配置，观察请求中的 `session_key` 自动生成。

## 检查清单

```
- [ ] 测试 1：recall 成功调用
- [ ] 测试 2：capture 成功调用，数据完整
- [ ] 测试 3：session/end 成功调用
- [ ] 测试 4：bridge-server 挂掉时 Agent 正常降级
- [ ] 测试 5：认证失败时正常降级
- [ ] 测试 6：session_key 自动生成功能正常
```

## 如何提 Issue

发现问题请到 https://github.com/kuaizhongqiang/TencentAgentMemoryBridge/issues/new 提 Issue，按以下模板：

```markdown
## Package
- [x] `openclaw-plugin`

## Reported By
- [x] OpenClaw

## Description
（描述问题）

## Environment
- 测试日期:
- bridge-server 地址:
- sessionKey 来源:

## Logs
（相关日志）
```
