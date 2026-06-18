# CodeBuddy MCP Bridge 测试指南

**仓库地址**：https://github.com/kuaizhongqiang/TencentAgentMemoryBridge

---

## 测试目标

验证 `mcp-bridge` 的 4 个 MCP 工具能正确连接 bridge-server，并正确转发数据到 TencentDB Agent Memory。

## 环境准备

### 1. bridge-server

```bash
git clone https://github.com/kuaizhongqiang/TencentAgentMemoryBridge.git
cd TencentAgentMemoryBridge
pnpm install
cd packages/bridge-server
pnpm dev
```

环境变量：

```bash
PORT=3000
TENCENTDB_URL=http://localhost:8080
AGENTS=[{"name":"codebuddy","apiKeyHash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","allowedEndpoints":["*"]}]
```

> `apiKeyHash` = sha256("test")，测试用 API_KEY 填 `test`。

### 2. CodeBuddy MCP 配置

```jsonc
// codebuddy.json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["tencent-agent-memory-mcp-bridge"],
      "env": {
        "BRIDGE_URL": "http://localhost:3000/api/v1",
        "API_KEY": "test",
        "SENDER": "codebuddy"
      }
    }
  }
}
```

## 测试用例

### 测试 1：store_memory

**操作**：让 Agent 调用 `store_memory` 工具。

**验证**：
- bridge-server 日志出现 `/api/v1/capture`，sender=codebuddy
- 请求体包含 `user_content`、`assistant_content`、`session_key`
- 返回成功

### 测试 2：recall_memory

**操作**：让 Agent 调用 `recall_memory` 工具。

**验证**：
- bridge-server 日志出现 `/api/v1/recall`，sender=codebuddy
- 请求体包含 `query`
- 返回数据（即使为空数组）

### 测试 3：search_memories

**操作**：让 Agent 调用 `search_memories` 工具。

**验证**：
- bridge-server 日志出现 `/api/v1/search/memories`
- 支持传可选参数 `limit`、`type`、`scene`

### 测试 4：end_session

**操作**：让 Agent 调用 `end_session` 工具。

**验证**：bridge-server 日志出现 `/api/v1/session/end`。

### 测试 5：session_key 自动生成

**操作**：不传 `session_key` 参数调用工具。

**验证**：请求中自动填入 `codebuddy-xxxxxxxx` 格式的 session_key。

### 测试 6：bridge-server 不可用时降级（mcp-bridge）

**操作**：不启动 bridge-server，让 Agent 调用任意工具。

**验证**：Agent 返回错误信息但不会崩溃，信息中包含 `Error: Bridge server error` 字样。

## 检查清单

```
- [ ] 测试 1：store_memory 正常存储
- [ ] 测试 2：recall_memory 正常召回
- [ ] 测试 3：search_memories 正常搜索
- [ ] 测试 4：end_session 正常结束会话
- [ ] 测试 5：session_key 自动生成
- [ ] 测试 6：bridge-server 不可用时正确报错
```

## 如何提 Issue

到 https://github.com/kuaizhongqiang/TencentAgentMemoryBridge/issues/new 提 Issue：

```markdown
## Package
- [x] `mcp-bridge`

## Reported By
- [x] CodeBuddy

## Description
（描述问题）

## Environment
- 测试日期:
- bridge-server 地址:

## Logs
（相关日志）
```
