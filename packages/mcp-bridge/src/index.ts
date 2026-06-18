#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config.js'
import { BridgeClient } from './client.js'

const config = loadConfig()
const client = new BridgeClient(config)

const TOOLS: Tool[] = [
  {
    name: 'recall_memory',
    description: 'Recall relevant memories before generating a response',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for relevant memories' },
        session_key: { type: 'string', description: 'Session key (auto-generated if omitted)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'store_memory',
    description: 'Store a conversation turn in memory after generation',
    inputSchema: {
      type: 'object',
      properties: {
        user_content: { type: 'string', description: 'User input text' },
        assistant_content: { type: 'string', description: 'Assistant response text' },
        session_key: { type: 'string', description: 'Session key (auto-generated if omitted)' },
      },
      required: ['user_content', 'assistant_content'],
    },
  },
  {
    name: 'search_memories',
    description: 'Search across stored memories',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum number of results' },
        type: { type: 'string', description: 'Filter by memory type' },
        scene: { type: 'string', description: 'Filter by scene' },
      },
      required: ['query'],
    },
  },
  {
    name: 'end_session',
    description: 'End the current memory session',
    inputSchema: {
      type: 'object',
      properties: {
        session_key: { type: 'string', description: 'Session key (auto-generated if omitted)' },
      },
      required: [],
    },
  },
]

const server = new Server(
  { name: 'tencent-agent-memory-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

function resolveSession(sessionKey: string | undefined | null): string {
  return sessionKey ?? config.sessionKey
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'recall_memory': {
        const data = await client.recall(
          args?.query as string,
          resolveSession(args?.session_key as string | undefined),
        )
        return { content: [{ type: 'text', text: JSON.stringify(data) }] }
      }

      case 'store_memory': {
        const data = await client.capture(
          args?.user_content as string,
          args?.assistant_content as string,
          resolveSession(args?.session_key as string | undefined),
        )
        return { content: [{ type: 'text', text: JSON.stringify(data) }] }
      }

      case 'search_memories': {
        const data = await client.searchMemories(args?.query as string, {
          limit: args?.limit as number | undefined,
          type: args?.type as string | undefined,
          scene: args?.scene as string | undefined,
        })
        return { content: [{ type: 'text', text: JSON.stringify(data) }] }
      }

      case 'end_session': {
        const data = await client.endSession(
          resolveSession(args?.session_key as string | undefined),
        )
        return { content: [{ type: 'text', text: JSON.stringify(data) }] }
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
