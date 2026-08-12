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
      'Recall relevant memories (L1 facts + L3 persona, optionally L2 scene index) for the current context',
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
    description: 'Store a conversation turn into L0 memory (write path, requires a session)',
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
    description: 'Semantic search across L1 atomic memories',
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
  { name: 'tencent-agent-memory-mcp-bridge', version: '0.3.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

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
        return { content: [{ type: 'text', text: JSON.stringify(data) }] }
      }

      case 'search_memories': {
        const data = await client.searchAtomic(args?.query as string, {
          limit: args?.limit as number | undefined,
          type: args?.type as string | undefined,
        })
        return { content: [{ type: 'text', text: JSON.stringify(data.items ?? []) }] }
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
