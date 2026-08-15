---
name: agent-memory-initializer
description: Initialize AgentMemory MCP (tencent-agent-memory-mcp-bridge) for CodeBuddy IDE and CLI in a new project. This skill should be used when the user wants to set up the AgentMemory system, connect to the team-edition memory bridge, configure auto-store hooks, or mentions "agent-memory", "记忆系统", "memory bridge", "mcp-bridge", "团队版记忆". Identity (team/agent/user) and project task_id are strictly separated: task_id is the project label (cwd-derived or explicit TASK_ID), NEVER an identity id (agt-/team-/usr- prefixes are rejected by mcp-bridge >= 0.4.0).
---

# AgentMemory Initializer

## Overview

Initialize the Tencent AgentMemory MCP bridge (`tencent-agent-memory-mcp-bridge`) in any project, configuring both CodeBuddy IDE and CLI with MCP tools (`recall_memory` / `store_memory` / `search_memories`) and a Stop hook for automatic conversation archiving to L0 memory.

## Identity vs Project (read this first — never mix them)

| Concept | Env var | Shape | Meaning | Changes per project? |
|---------|---------|-------|---------|----------------------|
| Platform identity | `AGENT_ID` | `agt-xxx` | CodeBuddy's agent identity (meta-registered entity) | ❌ fixed across projects |
| Team | `TEAM_ID` | `team-xxx` | Team | ❌ fixed |
| User | `USER_ID` | `usr-xxx` | The human user | ❌ fixed |
| **Project label** | `TASK_ID` | project name (e.g. `TencentAgentMemoryBridge`) | **Project-level isolation tag**, free-form string | ✅ one per project |

> ⚠️ **`task_id` is NEVER an identity id**: do not put `AGENT_ID`/`TEAM_ID`/`USER_ID`/keys into `TASK_ID`. mcp-bridge ≥ 0.4.0 rejects `agt-`/`team-`/`usr-`/`sk-` prefixed task_ids with a startup error. `task_id` answers "which project is this", identity answers "who am I" — different things.

## Architecture

The v3 team edition uses team/agent/user triples for memory isolation, plus an optional `task_id` tag for project-level isolation. Each agent (claude-code, codebuddy, openclaw, deepseek-harness) has its own memory domain under the same team and user.

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
8. `TASK_ID` — OPTIONAL. Project label. Leave unset to auto-derive from the project directory name (recommended); if set, it must be a project name, **never** an identity id.

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
        // TASK_ID: leave unset — auto-derived from project dir name.
        // If set, must be a project name; identity ids (agt-/team-/usr-/sk-) are REJECTED.
      },
      "description": "Tencent Agent Memory Bridge - 团队版记忆系统 (v3)"
    }
  }
}
```

Replace all `<...>` placeholders with actual credentials. Never put an identity id into `TASK_ID`.

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
2. Test write: call `store_memory` with a test message, verify `accepted_ids` is returned **and the `_context` block shows the expected `task_id` (project label) + `agent_id` (CodeBuddy identity)** — this confirms identity and task are correctly separated.
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

- The `tencent-agent-memory-mcp-bridge` npm package must be >= **0.4.0** for v3 team edition support (0.4.0 adds task_id anti-mixup validation and `_context` echo in tool results).
- **task_id rules**: leave `TASK_ID` unset to auto-derive the project label from the directory name; if set, use a project name. Identity ids (`agt-`/`team-`/`usr-`/`sk-` prefixes) are rejected at startup — never put `AGENT_ID`/`TEAM_ID`/`USER_ID`/keys into `TASK_ID`.
- Do NOT commit credential files (`.codebuddy/mcp.json` with real keys, `mem-agent-keys-*.md`) to git. Add them to `.gitignore`.
- The Stop hook uses `type: "command"` which is supported by both CodeBuddy IDE and CLI.
- If the project already has `.codebuddy/settings.json`, merge the `hooks.Stop` array instead of overwriting.
