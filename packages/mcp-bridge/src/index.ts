#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config.js'
import { V3MemoryClient } from './client.js'

const config = loadConfig()
const client = new V3MemoryClient(config)

const TOOLS: Tool[] = [
  {
    name: 'recall_memory',
    description:
      'Recall relevant memories for the CURRENT task (project). Returns L1 facts (project-scoped by task_id) plus optionally L3 persona and L2 scene index. ' +
      'Identity (team_id/agent_id/user_id) and task_id are fixed by the MCP server environment — never pass or guess them. ' +
      'agent_id is the platform identity (agt-*), task_id is the project label; they are different concepts and must not be mixed. ' +
      'Results include a _context block echoing the active isolation domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for relevant memories' },
        limit: { type: 'number', description: 'Max L1 facts to return (default 5)' },
        include_persona: { type: 'boolean', description: 'Include L3 persona (default true)' },
        include_scenes: { type: 'boolean', description: 'Include L2 scene index (default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'store_memory',
    description:
      'Store a conversation turn into L0 memory (write path, requires a session). ' +
      'Writes under the isolation triple (team_id/agent_id/user_id) and task_id fixed by the MCP server environment — no identity or task parameters are accepted. ' +
      'task_id is the project label, NOT the agent_id: do not invent or swap them. ' +
      'Results include a _context block echoing the active isolation domain.',
    inputSchema: {
      type: 'object',
      properties: {
        user_content: { type: 'string', description: 'User input text' },
        assistant_content: { type: 'string', description: 'Assistant response text' },
        session_key: { type: 'string', description: 'Session key (default: auto per agent+day)' },
      },
      required: ['user_content', 'assistant_content'],
    },
  },
  {
    name: 'search_memories',
    description:
      'Semantic search across L1 atomic memories of the CURRENT task (project-scoped by task_id). ' +
      'Identity and task_id come from the MCP server environment — do not pass agent_id/team_id/user_id/task_id. ' +
      'Results include a _context block echoing the active isolation domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum number of results' },
        type: { type: 'string', description: 'Filter by memory type' },
      },
      required: ['query'],
    },
  },
]

const server = new Server(
  { name: 'tencent-agent-memory-mcp-bridge', version: '0.4.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

/**
 * 回显当前隔离上下文（不含任何 key）。让模型/用户明确感知本次调用落在
 * 哪个 (team, agent, user, task) 域，避免把 agent_id 当 task_id 用或反之。
 */
function contextEcho(): Record<string, string | undefined> {
  return {
    team_id: config.teamId,
    agent_id: config.agentId,
    user_id: config.userId,
    task_id: config.taskId,
  }
}

function resolveSession(sessionKey: string | undefined | null): string {
  return sessionKey || config.sessionKey
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'recall_memory': {
        const query = args?.query as string
        const limit = args?.limit as number | undefined
        const includePersona = args?.include_persona !== false
        const includeScenes = args?.include_scenes === true

        const [facts, persona, scenes] = await Promise.all([
          client.searchAtomic(query, { limit }),
          includePersona ? client.readCore() : Promise.resolve(null),
          includeScenes ? client.listScenarios() : Promise.resolve(null),
        ])

        const result: Record<string, unknown> = {
          facts: facts.items ?? [],
        }
        if (includePersona && persona?.content) result.persona = persona.content
        if (includeScenes && scenes?.entries?.length) result.scenes = scenes.entries
        result._context = contextEcho()
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'store_memory': {
        const data = await client.addConversation(
          [
            { role: 'user', content: args?.user_content as string },
            { role: 'assistant', content: args?.assistant_content as string },
          ],
          resolveSession(args?.session_key as string | undefined),
        )
        const out = { ...data, _context: contextEcho() }
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      case 'search_memories': {
        const data = await client.searchAtomic(args?.query as string, {
          limit: args?.limit as number | undefined,
          type: args?.type as string | undefined,
        })
        return {
          content: [
            { type: 'text', text: JSON.stringify({ items: data.items ?? [], _context: contextEcho() }) },
          ],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

// Re-export types for consumers who import the package
export type { McpConfig } from './config.js'
export { V3MemoryClient, type V3ClientConfig } from './client.js'
