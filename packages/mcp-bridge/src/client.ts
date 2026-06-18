export interface BridgeClientConfig {
  bridgeUrl: string
  apiKey: string
  sender: string
}

export class BridgeClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.bridgeUrl.replace(/\/+$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'X-Sender': config.sender,
    }
  }

  async recall(query: string, sessionKey?: string) {
    return this.post('/recall', { query, session_key: sessionKey })
  }

  async capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    opts?: { sessionId?: string; messages?: unknown[] },
  ) {
    return this.post('/capture', {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
      session_id: opts?.sessionId,
      messages: opts?.messages,
    })
  }

  async searchMemories(query: string, opts?: { limit?: number; type?: string; scene?: string }) {
    return this.post('/search/memories', { query, ...opts })
  }

  async endSession(sessionKey: string) {
    return this.post('/session/end', { session_key: sessionKey })
  }

  private async post(path: string, body: unknown) {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!res.ok) {
      throw new Error(`Bridge server error (${res.status}): ${JSON.stringify(data)}`)
    }
    return data
  }
}
