export interface V3ClientConfig {
  endpoint: string
  apiKey: string
  serviceId: string
  teamId: string
  agentId: string
  userId: string
  sessionKey: string
  timeoutMs?: number
}

interface V3Envelope<T = unknown> {
  code?: number
  message?: string
  data?: T
}

export interface MemoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AtomicItem {
  id: string
  content: string
  type?: string
  score?: number
  updated_at?: string
}

export interface CoreFile {
  path?: string
  content: string
  updated_at?: string
}

export interface ScenarioEntry {
  path: string
  summary?: string
  updated_at?: string
}

export interface ConversationAddData {
  accepted_ids?: string[]
  accepted_versions?: string[]
  total_count?: number
}

/**
 * v3 strict-isolation 数据面客户端（裸 HTTP，直连 MemoryCore Gateway）。
 *
 * 协议：
 *   - 所有请求带 `Authorization: Bearer <apiKey>` + `x-tdai-service-id: <spaceId>`
 *   - 请求体带隔离三元组 team_id / agent_id / user_id
 *   - 写路径（conversation/add）必须带 session_id
 *   - 响应为 envelope { code, message, data }，code!==0 视为失败
 */
export class V3MemoryClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly iso: { team_id: string; agent_id: string; user_id: string }
  private readonly sessionKey: string
  private readonly timeoutMs: number

  constructor(config: V3ClientConfig) {
    this.baseUrl = config.endpoint.replace(/\/+$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'x-tdai-service-id': config.serviceId,
    }
    this.iso = { team_id: config.teamId, agent_id: config.agentId, user_id: config.userId }
    this.sessionKey = config.sessionKey
    this.timeoutMs = config.timeoutMs ?? 15000
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let envelope: V3Envelope<T>
      try {
        envelope = JSON.parse(text) as V3Envelope<T>
      } catch {
        throw new Error(`MemoryCore ${path} returned non-JSON (${res.status}): ${text.slice(0, 300)}`)
      }
      const code = typeof envelope.code === 'number' ? envelope.code : undefined
      if (!res.ok || (code !== undefined && code !== 0)) {
        throw new Error(`MemoryCore ${path} error (${res.status}${code !== undefined ? ` code=${code}` : ''}): ${envelope.message ?? text.slice(0, 300)}`)
      }
      return (envelope.data ?? {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...this.iso, ...extra }
  }

  /** 写 L0：把一段对话写入短期记忆 */
  addConversation(messages: MemoryMessage[], sessionId?: string): Promise<ConversationAddData> {
    const sid = sessionId ?? this.sessionKey
    if (!sid) throw new Error('addConversation requires a session_id')
    return this.post('/v3/conversation/add', this.baseBody({ session_id: sid, messages }))
  }

  /** 查 L1：语义搜索原子事实 */
  searchAtomic(
    query: string,
    opts: { limit?: number; type?: string; sessionId?: string } = {},
  ): Promise<{ items?: AtomicItem[] }> {
    const body = this.baseBody({
      session_id: opts.sessionId ?? this.sessionKey,
      query,
      limit: opts.limit,
      type: opts.type,
    })
    for (const k of ['limit', 'type']) if (body[k] === undefined) delete body[k]
    return this.post('/v3/atomic/search', body)
  }

  /** 读 L3：agent 长期画像（persona） */
  readCore(): Promise<CoreFile> {
    return this.post('/v3/core/read', this.baseBody())
  }

  /** 列 L2：场景导航索引 */
  listScenarios(pathPrefix = ''): Promise<{ entries?: ScenarioEntry[] }> {
    return this.post('/v3/scenario/ls', this.baseBody({ path_prefix: pathPrefix }))
  }
}
