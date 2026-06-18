# CODEBUDDY.md
This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概述

**TencentAgentMemoryBridge** — 围绕 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 开源项目构建的记忆桥梁。聚焦 **3 个方向**：

| # | 方向 | 目标平台 | 交付物 |
|---|------|---------|--------|
| 1 | **MCP Bridge**（P0） | CodeBuddy + Claude Code | MCP Server（一套代码两份配置） |
| 2 | **OpenClaw 插件改造**（P1） | OpenClaw 框架 | 增强插件（多 Agent 共享记忆） |
| 3 | **场景增强**（P2） | 各平台 | 专属工具 + 调试面板 |

当前处于 **设计阶段 v0.3**，完整设计方案见 `docs/design-overview.md`。

## 项目文档

| 文档 | 说明 |
|------|------|
| `docs/design-overview.md` | 完整技术方案（v0.3，聚焦 3 方向） |

## 技术栈

| 领域 | 选型 |
|------|------|
| 包管理 | pnpm workspace (Monorepo) |
| 语言 | TypeScript |
| 构建 | tsup / tsdown |
| 测试 | Vitest |
| MCP SDK | `@modelcontextprotocol/sdk` |
| 上游依赖 | `@tencentdb-agent-memory/memory-tencentdb` (>=0.3.x) |

## 目录结构

```
tencent-agent-memory-bridge/
├── packages/
│   ├── mcp-bridge/            # MCP Server (CodeBuddy + Claude Code)
│   └── openclaw-plugin/       # OpenClaw 插件改造
├── examples/
│   ├── codebuddy/             # CodeBuddy MCP 配置
│   └── claude-code/           # Claude Code MCP 配置
├── docs/
│   └── design-overview.md
└── package.json
```

## 开发命令

*项目尚未进入编码阶段。待 Phase 1 启动后确认。*

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 运行测试
pnpm test

# 启动 MCP Bridge（开发模式）
pnpm --filter mcp-bridge dev

# 构建 OpenClaw 插件
pnpm --filter openclaw-plugin build
```

## 开发提醒

- 编码前必读 `docs/design-overview.md` 了解完整架构
- **P0 是 MCP Bridge**：一套代码同时服务 CodeBuddy 和 Claude Code
- OpenClaw 插件改造在上游插件基础上增强，不 fork
- 所有包共享 pnpm workspace
