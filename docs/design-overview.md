# TencentAgentMemoryBridge 设计文档 v0.3

> **版本**: v0.3-draft  
> **状态**: 设计阶段  
> **日期**: 2026-06-18  
> **上游项目**: [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (v0.3.6, MIT)

---

## 1. 项目定位

### 1.1 核心理念

**TencentAgentMemoryBridge** 围绕 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（腾讯开源的 4 层分层记忆引擎）构建记忆桥梁，使不同 Agent 生态获得长期记忆能力。

**不做**：自研记忆系统、替代上游引擎  
**做**：将上游引擎以合适的方式接入不同 Agent 平台

### 1.2 上游项目速览

TencentDB Agent Memory 的核心能力：

| 层次 | 内容 | 存储 |
|------|------|------|
| **L0 - Conversation** | 原始对话记录 | SQLite |
| **L1 - Atom** | 提取的事实片段 | SQLite + 向量嵌入 |
| **L2 - Scenario** | 相关事实构成的场景 | Markdown 文件 |
| **L3 - Persona** | 用户长期偏好/画像 | `persona.md` |

**短期卸载**：工具日志卸载到 `refs/*.md`，上下文仅保留 Mermaid 任务图（数百 token）。

**核心 API（来自 TdaiCore）**：

```typescript
class TdaiCore {
  // 初始化
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  // 生成前：召回相关记忆
  handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult>;

  // 生成后：捕获对话到 L0
  handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult>;

  // 语义搜索 L1 记忆
  searchMemories(params: MemorySearchParams): Promise<SearchResult>;

  // 搜索 L0 对话
  searchConversations(params: ConversationSearchParams): Promise<SearchResult>;

  // 结束会话
  handleSessionEnd(sessionKey: string): Promise<void>;
}
```

**HTTP Gateway 端点（上游已提供）**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/recall` | 生成前召回记忆 |
| POST | `/capture` | 对话捕获 |
| POST | `/search/memories` | L1 语义搜索 |
| POST | `/search/conversations` | L0 对话搜索 |
| POST | `/session/end` | 结束会话 |
| POST | `/seed` | 批量导入历史数据 |
| GET | `/health` | 健康检查 |

---

## 2. 三大方向

### 2.1 方向一：CodeBuddy MCP Bridge

**目标**：将 TencentDB Agent Memory 包装为一个 MCP Server，使 CodeBuddy（当前 IDE）能通过 MCP 协议读写 Agent 长期记忆。

**使用场景**：CodeBuddy 在开发过程中维护项目级、会话级的长期记忆上下文。

#### 架构

```
CodeBuddy IDE
    │
    ├── MCP Client (内置)
    │       │
    │       ▼
    │  MCP Bridge Server (stdio)
    │  ┌──────────────────────────────┐
    │  │  tools/list                  │
    │  │  tools/call                  │
    │  │  resources/read              │
    │  │  prompts/get                 │
    │  └──────────┬───────────────────┘
    │             │
    │             ▼
    │  ┌──────────────────────────────┐
    │  │  Memory Engine (TdaiCore)    │
    │  │  + SQLite + sqlite-vec       │
    │  │  (本地存储，无外部依赖)       │
    │  └──────────────────────────────┘
```

#### MCP 工具定义

```typescript
// 暴露给 CodeBuddy 的 MCP 工具

const tools = [
  // 1. 召回记忆（生成前自动调用）
  {
    name: "recall_memory",
    description: "根据当前查询或上下文，召回相关的长期记忆。在生成回复前调用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "当前用户查询或上下文文本" },
        session_key: { type: "string", description: "会话标识" },
      },
      required: ["query"],
    },
  },

  // 2. 存储记忆（生成后调用）
  {
    name: "store_memory",
    description: "将一次对话交互记录到长期记忆中。在生成回复后调用。",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "用户输入" },
        assistant_content: { type: "string", description: "助手回复" },
        session_key: { type: "string", description: "会话标识" },
      },
      required: ["user_content", "assistant_content"],
    },
  },

  // 3. 语义搜索
  {
    name: "search_memories",
    description: "在长期记忆中执行语义搜索，查找相关记忆片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        limit: { type: "number", default: 10 },
        type: { type: "string", description: "记忆类型过滤" },
      },
      required: ["query"],
    },
  },

  // 4. 获取用户画像
  {
    name: "get_persona",
    description: "获取当前用户的长期画像（L3 Persona），包含偏好、风格等。",
    inputSchema: { type: "object", properties: {} },
  },

  // 5. 获取场景模块
  {
    name: "get_scenarios",
    description: "获取当前用户的场景模块列表（L2 Scenarios）。",
    inputSchema: { type: "object", properties: {} },
  },
];
```

#### MCP Resources 定义

```typescript
const resources = [
  {
    uri: "memory://persona",
    name: "用户画像",
    description: "当前用户的长期画像 (L3)",
    mimeType: "text/markdown",
  },
  {
    uri: "memory://scenarios",
    name: "场景列表",
    description: "所有场景模块 (L2)",
    mimeType: "application/json",
  },
  {
    uri: "memory://session/{session_key}/recent",
    name: "最近会话",
    description: "指定会话的最近上下文",
    mimeType: "application/json",
  },
];
```

#### 关键设计决策

| 决策 | 选项 | 选择理由 |
|------|------|---------|
| 传输协议 | **stdio** | CodeBuddy 本地进程，无需网络 |
| 嵌入模型 | **local (sqlite-vec)** 或 **remote** | 优先本地，无外部 API 依赖；可选 remote 提升精度 |
| 存储后端 | **SQLite** | 零配置，随 MCP Server 一起启动 |
| 启动方式 | `npx @tencent-agent-memory/mcp-bridge` | 零安装成本 |
| 配置 | MCP settings JSON | CodeBuddy 标准 MCP 配置方式 |

**CodeBuddy MCP 配置示例**：

```jsonc
// codebuddy.json 或 MCP settings
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "MEMORY_STORE": "sqlite",
        "MEMORY_DATA_DIR": "./.agent-memory"
      }
    }
  }
}
```

---

### 2.2 方向二：Claude Code MCP Bridge

**目标**：使 Claude Code（Anthropic 的 CLI Agent 工具）通过 MCP 协议获得长期记忆能力。

**与 CodeBuddy Bridge 的区别**：

| 维度 | CodeBuddy Bridge | Claude Code Bridge |
|------|------------------|--------------------|
| 运行环境 | CodeBuddy IDE 内部 | Claude Code CLI 进程 |
| 传输协议 | stdio | stdio |
| 记忆范围 | 项目级 + 会话级 | 项目级 + CLI 会话级 |
| 特殊需求 | 需要感知项目上下文 | 需要感知 Git/文件变更上下文 |
| 启动方式 | CodeBuddy MCP 配置 | Claude Code MCP 配置 |

**核心工具**：与 CodeBuddy MCP Bridge 一致（`recall_memory`, `store_memory`, `search_memories`, `get_persona` 等）。

**Claude Code 专属增强**：

```typescript
// Claude Code 专属工具（额外暴露）
const claudeCodeTools = [
  ...commonTools,

  // 项目知识索引
  {
    name: "index_project_knowledge",
    description: "将项目中的关键文档/代码片段索引到长期记忆",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "内容摘要或关键点" },
        tags: { type: "array", items: { type: "string" }, description: "标签" },
      },
      required: ["file_path", "content"],
    },
  },

  // 决策记录
  {
    name: "record_decision",
    description: "记录一次架构或技术决策，供后续参考",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        context: { type: "string" },
        decision: { type: "string" },
        alternatives: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "context", "decision"],
    },
  },
];
```

**Claude Code MCP 配置**：

```jsonc
// ~/.claude/settings.json 或项目级 .claude/settings.json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["@tencent-agent-memory/mcp-bridge"],
      "env": {
        "MEMORY_STORE": "sqlite",
        "MEMORY_DATA_DIR": "./.agent-memory"
      }
    }
  }
}
```

---

### 2.3 方向三：OpenClaw 插件改造

**目标**：基于上游已有的 `@tencentdb-agent-memory/memory-tencentdb` OpenClaw 插件，进行**增强改造**，增加多 Agent 共享记忆和自定义配置能力。

**与上游的关系**：

```
上游插件 (memory-tencentdb v0.3.6)
├── 开箱即用的 OpenClaw 集成
├── 4 层记忆流水线
├── 短时压缩 (Mermaid 任务图)
└── SQLite + sqlite-vec

我们的改造
├── 基于上游插件开发，非 fork
├── 新增: 多 Agent 共享记忆层
├── 新增: 配置预设模板
├── 新增: 记忆可视化/调试面板
└── 新增: 自定义场景标签
```

#### 改造方案

**方案 A：独立封装插件（推荐）**

开发一个新的 OpenClaw 插件 `@tencent-agent-memory/memory-bridge`，内部依赖上游插件 + 增加共享层。

```typescript
// 新插件架构
import { TdaiCore } from '@tencentdb-agent-memory/memory-tencentdb';

class MemoryBridgePlugin implements OpenClawPlugin {
  private cores: Map<string, TdaiCore>; // 每个 Agent 一个 Core 实例
  private sharedStore: SharedMemoryStore; // 共享记忆存储

  async onActivate(api: OpenClawPluginApi) {
    // 1. 加载配置（含多 Agent 配置）
    const config = this.loadConfig(api);

    // 2. 为每个 Agent 初始化 TdaiCore
    for (const agentConfig of config.agents) {
      const core = new TdaiCore({
        hostAdapter: new OpenClawHostAdapter({ api, ... }),
        config: agentConfig.memoryConfig,
      });
      await core.initialize();
      this.cores.set(agentConfig.agentId, core);
    }

    // 3. 初始化共享存储
    this.sharedStore = new SharedMemoryStore(config.sharedStore);
  }

  // 钩子：生成前 - 召回私有 + 共享记忆
  async beforePromptBuild(context: PromptContext) {
    const agentId = this.resolveAgentId(context);
    const core = this.cores.get(agentId);

    // 召回私有记忆
    const privateMemories = await core.handleBeforeRecall(context.userText, context.sessionKey);

    // 召回共享记忆
    const sharedMemories = await this.sharedStore.search({
      query: context.userText,
      accessibleBy: agentId,
    });

    return this.mergeContext(privateMemories, sharedMemories);
  }

  // 钩子：生成后 - 捕获对话（可指定共享范围）
  async afterAgentEnd(context: AgentEndContext) {
    const agentId = this.resolveAgentId(context);
    const core = this.cores.get(agentId);
    const turn = this.buildCompletedTurn(context);

    // 写入私有记忆
    await core.handleTurnCommitted(turn);

    // 如果需要共享，也写入共享存储
    if (context.metadata?.shareWith) {
      await this.sharedStore.store({
        ...turn,
        scope: 'shared',
        accessibleBy: context.metadata.shareWith,
      });
    }
  }
}
```

**方案 B：配置模板增强（轻量方案）**

不写新代码，而是提供一组**配置预设模板**，让用户通过配置实现多场景。

```jsonc
// 配置预设模板示例

// 模板1：单 Agent 开发助手
{
  "memory-tencentdb": {
    "enabled": true,
    "config": {
      "pipeline": { "everyNConversations": 3, "enableWarmup": true },
      "persona": { "triggerEveryN": 30 },
      "recall": { "strategy": "hybrid", "maxResults": 5 }
    }
  }
}

// 模板2：多 Agent 客服系统
// (需要配合改造后的插件)
{
  "memory-bridge": {
    "enabled": true,
    "agents": [
      { "id": "customer-service", "scope": "private" },
      { "id": "logistics", "scope": "shared" }
    ],
    "sharedStore": {
      "type": "sqlite",
      "path": "~/.openclaw/shared-memory.db"
    }
  }
}
```

#### 共享记忆实现

利用上游的 `metadata` 扩展字段实现多 Agent 隔离：

```typescript
// 写入共享记忆时
await core.handleTurnCommitted({
  ...turn,
  metadata: {
    // 上游插件原字段
    // ... 
    // 我们的扩展
    bridge_scope: 'shared',          // private | shared | global
    bridge_agent_id: 'agent_a',
    bridge_accessible_by: ['agent_a', 'agent_b'], // 白名单
  },
});

// 检索共享记忆时（通过 tags 或 metadata 过滤）
const sharedResults = await core.searchMemories({
  query: '...',
  // 利用上游已有的 filter 机制
  filter: {
    'metadata.bridge_scope': 'shared',
    'metadata.bridge_accessible_by': { $contains: currentAgentId },
  },
});
```

---

## 3. 三种方向的实施策略

### 3.1 优先级建议

```
P0 ─── MCP Bridge（通用）
       ├── 覆盖 CodeBuddy 和 Claude Code
       └── 一套代码，两份配置

P1 ─── OpenClaw 插件改造
       └── 基于上游已有插件增量开发

P2 ─── 场景特定增强
       ├── CodeBuddy 专属工具
       └── Claude Code 专属工具
```

**为什么 MCP Bridge 是 P0**：
- 一套 MCP Server 同时服务 CodeBuddy 和 Claude Code（MCP 是标准协议）
- 与 CodeBuddy IDE 天然集成
- Claude Code 通过 MCP 配置即可接入
- 无需理解 OpenClaw 插件体系

### 3.2 Monorepo 包结构

```
tencent-agent-memory-bridge/
├── packages/
│   ├── mcp-bridge/                 # MCP Server (覆盖方向1+2)
│   │   ├── src/
│   │   │   ├── server.ts           # MCP Server 入口
│   │   │   ├── tools/              # 工具实现
│   │   │   │   ├── recall.ts
│   │   │   │   ├── store.ts
│   │   │   │   ├── search.ts
│   │   │   │   └── persona.ts
│   │   │   ├── resources/          # Resource 实现
│   │   │   └── engine.ts           # TdaiCore 封装
│   │   └── package.json
│   │
│   └── openclaw-plugin/            # OpenClaw 插件改造 (方向3)
│       ├── src/
│       │   ├── index.ts            # 插件入口
│       │   ├── host-adapter.ts     # HostAdapter 实现
│       │   ├── shared-store.ts     # 共享记忆存储
│       │   └── config.ts           # 配置解析
│       └── package.json
│
├── examples/
│   ├── codebuddy/                  # CodeBuddy MCP 配置示例
│   └── claude-code/                # Claude Code MCP 配置示例
│
├── docs/
│   ├── design-overview.md          # 本文件
│   ├── mcp-bridge.md               # MCP Bridge 使用文档
│   └── openclaw-plugin.md          # OpenClaw 插件文档
│
├── package.json                    # Root workspace
├── pnpm-workspace.yaml
├── CODEBUDDY.md
└── README.md
```

### 3.3 技术依赖

| 包 | 依赖 |
|----|------|
| `mcp-bridge` | `@modelcontextprotocol/sdk`, `@tencentdb-agent-memory/memory-tencentdb` |
| `openclaw-plugin` | `@tencentdb-agent-memory/memory-tencentdb`, `openclaw` (peer) |

---

## 4. 开发路线图

### Phase 1：MCP Bridge（P0）

| 步骤 | 内容 | 交付 |
|------|------|------|
| 1.1 | 项目初始化：pnpm workspace、TypeScript 配置 | 可构建的空项目 |
| 1.2 | TdaiCore 引擎封装层 | `Engine` 类，封装初始化/recall/capture/search |
| 1.3 | MCP 协议集成：`tools/list` + `tools/call` | 基本 MCP Server 可运行 |
| 1.4 | 核心工具实现：recall / store / search / persona | 4 个 MCP 工具可用 |
| 1.5 | MCP Resources 实现：persona / scenarios | Resource 支持 |
| 1.6 | 配置读取 + 数据目录管理 | 可配置数据路径 |
| 1.7 | CodeBuddy MCP 配置示例 | 接入文档 |
| 1.8 | Claude Code MCP 配置示例 | 接入文档 |

### Phase 2：OpenClaw 插件改造（P1）

| 步骤 | 内容 | 交付 |
|------|------|------|
| 2.1 | 理解上游插件入口和生命周期 | 分析文档 |
| 2.2 | 多 Agent Core 实例管理 | 多 Agent 初始化 |
| 2.3 | 共享记忆存储实现 | 跨 Agent 读写 |
| 2.4 | 配置预设模板 | 开箱即用配置 |
| 2.5 | 与上游插件兼容性测试 | 不破坏现有功能 |

### Phase 3：场景增强（P2）

| 步骤 | 内容 | 交付 |
|------|------|------|
| 3.1 | CodeBuddy 专属工具（项目知识索引等） | 增强 MCP 工具 |
| 3.2 | Claude Code 专属工具（决策记录等） | 增强 MCP 工具 |
| 3.3 | 记忆可视化/调试面板 | OpenClaw 增强 |

---

## 5. 与上游项目的关系总结

| 维度 | 上游 (memory-tencentdb) | MCP Bridge | OpenClaw Plugin 改造 |
|------|------------------------|------------|---------------------|
| 角色 | 记忆引擎 | 协议适配 | 功能增强 |
| 复用 | — | 直接依赖 npm 包 | 直接依赖 npm 包 |
| 新增 | — | MCP 协议层 | 多 Agent 共享层 |
| 是否 fork | — | 否 | 否（独立插件） |
| 启动方式 | OpenClaw 插件 | `npx` / 直接运行 | OpenClaw 插件 |

---

> **下一步**：确认设计方向后，从 **Phase 1.1**（项目初始化）开始编码。MCP Bridge 是第一个交付目标，完成后 CodeBuddy 和 Claude Code 均可直接接入。
