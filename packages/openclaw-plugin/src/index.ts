export interface MemoryBridgeConfig {
  bridgeUrl: string
  apiKey: string
  sender: string
}

export interface HookContext {
  sessionKey: string
  userInput?: string
  userText?: string
  assistantOutput?: string
  [key: string]: unknown
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
  return res.json()
}

export class MemoryBridgePlugin {
  private config: MemoryBridgeConfig

  constructor(config: MemoryBridgeConfig) {
    this.config = config
  }

  async beforePromptBuild(ctx: HookContext): Promise<unknown> {
    try {
      const url = `${this.config.bridgeUrl}/recall`
      return await httpPost(url, {
        query: ctx.userText ?? ctx.userInput ?? '',
        session_key: ctx.sessionKey,
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
        session_key: ctx.sessionKey,
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
        session_key: ctx.sessionKey,
      }, buildHeaders(this.config))
    } catch (err) {
      console.error('[memory-bridge] session/end failed (silent):', err)
      return null
    }
  }
}
