import { randomUUID } from 'node:crypto'

export interface MemoryBridgeConfig {
  bridgeUrl: string
  apiKey: string
  sender: string
  sessionKey?: string
}

export interface HookContext {
  sessionKey?: string
  userInput?: string
  userText?: string
  assistantOutput?: string
}

const BASE_HEADERS = {
  'Content-Type': 'application/json',
} as const

function buildHeaders(config: MemoryBridgeConfig): Record<string, string> {
  return {
    ...BASE_HEADERS,
    Authorization: `Bearer ${config.apiKey}`,
    'X-Sender': config.sender,
  }
}

async function httpPost(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`Bridge server error (${res.status}): ${JSON.stringify(data)}`)
  }
  return data
}

export class MemoryBridgePlugin {
  private config: MemoryBridgeConfig
  private resolvedSessionKey: string

  constructor(config: MemoryBridgeConfig) {
    this.config = config
    this.resolvedSessionKey = config.sessionKey ?? `openclaw-${randomUUID().slice(0, 8)}`
  }

  private resolveSession(ctx: HookContext): string {
    return ctx.sessionKey || this.resolvedSessionKey
  }

  async beforePromptBuild(ctx: HookContext): Promise<unknown> {
    try {
      const url = `${this.config.bridgeUrl}/recall`
      return await httpPost(url, {
        query: ctx.userText ?? ctx.userInput ?? '',
        session_key: this.resolveSession(ctx),
      }, buildHeaders(this.config))
    } catch (err) {
      console.error('[memory-bridge] recall failed (silent):', err)
      return null
    }
  }

  async afterAgentEnd(ctx: HookContext): Promise<unknown> {
    try {
      const url = `${this.config.bridgeUrl}/capture`
      return await httpPost(url, {
        user_content: ctx.userInput ?? '',
        assistant_content: ctx.assistantOutput ?? '',
        session_key: this.resolveSession(ctx),
      }, buildHeaders(this.config))
    } catch (err) {
      console.error('[memory-bridge] capture failed (silent):', err)
      return null
    }
  }

  async onSessionEnd(ctx: HookContext): Promise<unknown> {
    try {
      const url = `${this.config.bridgeUrl}/session/end`
      return await httpPost(url, {
        session_key: this.resolveSession(ctx),
      }, buildHeaders(this.config))
    } catch (err) {
      console.error('[memory-bridge] session/end failed (silent):', err)
      return null
    }
  }
}
