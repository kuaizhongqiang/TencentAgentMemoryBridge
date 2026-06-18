# TencentAgentMemoryBridge

围绕 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 构建的记忆桥梁生态——将 4 层长期记忆能力接入不同的 Agent 平台。

## 项目目标

**不造轮子**。我们复用腾讯开源的 TencentDB Agent Memory（L0 对话 → L1 原子事实 → L2 场景 → L3 画像）作为记忆引擎，通过以下桥梁让不同生态的 Agent 获得长期记忆能力：

- **MCP Bridge** — 通过 MCP（Model Context Protocol）协议，让 CodeBuddy、Claude Code 等工具获得长期记忆
- **OpenClaw Plugin** — 增强 OpenClaw 生态的多 Agent 共享记忆能力

## 快速开始

### MCP Bridge（适用于 CodeBuddy / Claude Code）

```bash
npx @tencent-agent-memory/mcp-bridge
```

然后在工具中配置 MCP Server：

<details>
<summary>CodeBuddy 配置</summary>

```jsonc
// codebuddy.json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "MEMORY_DATA_DIR": "./.agent-memory"
      }
    }
  }
}
```
</details>

<details>
<summary>Claude Code 配置</summary>

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "MEMORY_DATA_DIR": "./.agent-memory"
      }
    }
  }
}
```
</details>

## 项目结构

```
tencent-agent-memory-bridge/
├── packages/
│   ├── mcp-bridge/            # MCP Server（CodeBuddy + Claude Code）
│   └── openclaw-plugin/       # OpenClaw 插件改造
├── examples/                  # 配置示例
├── docs/                      # 设计文档
└── package.json
```

## 上游依赖

- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — 腾讯开源的 4 层本地长期记忆系统（MIT 协议）

## License

MIT
