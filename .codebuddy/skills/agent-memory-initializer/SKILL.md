---
name: agent-memory-initializer
description: Initialize AgentMemory MCP (tencent-agent-memory-mcp-bridge) for CodeBuddy IDE and CLI in a new project. This skill should be used when the user wants to set up the AgentMemory system, connect to the team-edition memory bridge, configure auto-store hooks, or mentions "agent-memory", "记忆系统", "memory bridge", "mcp-bridge", "团队版记忆".
---

# AgentMemory Initializer

## Overview

Initialize the Tencent AgentMemory MCP bridge (`tencent-agent-memory-mcp-bridge`) in any project, configuring both CodeBuddy IDE and CLI with MCP tools (`recall_memory` / `store_memory` / `search_memories`) and a Stop hook for automatic conversation archiving to L0 memory.

## Architecture

The v3 team edition uses team/agent/user triples for memory isolation. Each agent (claude-code, codebuddy, openclaw) has its own memory domain under the same team and user.

| Component | Path | Target |
|-----------|------|--------|
| MCP config (CLI) | `<project>/.mcp.json` | CodeBuddy CLI |
| MCP config (IDE) | `<project>/.codebuddy/mcp.json` | CodeBuddy IDE |
| Hook config | `<project>/.codebuddy/settings.json` | Both IDE + CLI |
| Stop hook script | `<project>/scripts/stop-memory-store.mjs` | Both IDE + CLI |

## Prerequisites Check

Before starting, determine if the user has credentials available. Ask for the following values if they are not already present in the project or conversation:

1. `API_KEY` — Gateway authentication key (shared across all agents)
2. `TEAM_ID` — Team ID, format `team-xxx`
3. `AGENT_ID` — Agent ID for CodeBuddy, format `agt-xxx`
4. `USER_ID` — User ID, format `usr-xxx`
5. `USER_KEY` — User-level key, format `sk-mem-...` (optional, for meta queries)
6. `MEMORY_ENDPOINT` — Gateway URL (default: `https://memory.kuai-private.top`)
7. `SERVICE_ID` — Space ID (default: `default`)

If the user has a `mem-agent-keys-*.md` file or can provide a reference project, extract credentials from there. Otherwise, ask the user to provide them.

## Workflow

### Step 1: Install the Bridge Package

Run global installation:

```bash
npm install -g tencent-agent-memory-mcp-bridge@latest
```

Verify:

```bash
npm ls -g tencent-agent-memory-mcp-bridge
```

### Step 2: Create MCP Configuration Files

Create **two** MCP config files with identical content. The CLI reads `.mcp.json` first; the IDE reads `.codebuddy/mcp.json`.

Content template for both files:

```json
{
  "mcpServers": {
    "agent-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tencent-agent-memory-mcp-bridge"],
      "env": {
        "MEMORY_ENDPOINT": "<gateway-url>",
        "API_KEY": "<gate-api-key>",
        "SERVICE_ID": "default",
        "TEAM_ID": "<team-id>",
        "AGENT_ID": "<agent-id>",
        "USER_ID": "<user-id>",
        "USER_KEY": "<user-key>"
      },
      "description": "Tencent Agent Memory Bridge - 团队版记忆系统 (v3)"
    }
  }
}
```

Replace all `<...>` placeholders with actual credentials.

### Step 3: Deploy the Stop Hook Script

Copy `scripts/stop-memory-store.mjs` from this skill's bundled resources to `<project>/scripts/stop-memory-store.mjs`.

The script:
- Reads credentials from `.codebuddy/mcp.json` (shared fact source)
- Parses the transcript JSONL from CodeBuddy's Stop event stdin
- Extracts the last user + assistant turn
- POSTs to `/v3/conversation/add` on the MemoryCore gateway
- Deduplicates by session key + assistant timestamp (stores state in `.codebuddy/.memory-store-state.json`)
- Always exits 0 on failure (never blocks the user)

### Step 4: Create Hook Configuration

Create `<project>/.codebuddy/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/stop-memory-store.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Step 5: Verify

1. Check that `recall_memory`, `store_memory`, `search_memories` tools are registered (use `mcp_get_tool_description`).
2. Test write: call `store_memory` with a test message, verify `accepted_ids` is returned.
3. Test the hook: run the stop-memory-store script with a mock transcript via stdin (dry-run mode available with `--dry-run` flag).
4. Inform the user to **restart CodeBuddy** for changes to take effect.

### Step 6: Summary

After completion, list all created/modified files and their purposes. Remind the user that:
- The IDE needs a restart for MCP tools to appear.
- The CLI needs `codebuddy` restart for both MCP and hooks.
- First-time project-level MCP servers require approval in CLI mode.

## Bundled Resources

- `scripts/stop-memory-store.mjs` — Stop hook script for auto-archiving conversations
- `references/architecture.md` — Detailed architecture reference for the v3 team edition

## Notes

- The `tencent-agent-memory-mcp-bridge` npm package must be >= 0.3.1 for v3 team edition support.
- Do NOT commit credential files (`.codebuddy/mcp.json` with real keys, `mem-agent-keys-*.md`) to git. Add them to `.gitignore`.
- The Stop hook uses `type: "command"` which is supported by both CodeBuddy IDE and CLI.
- If the project already has `.codebuddy/settings.json`, merge the `hooks.Stop` array instead of overwriting.
