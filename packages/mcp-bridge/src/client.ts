export interface V3ClientConfig {
  /** 主端点（= endpoints[0]）。仅传 endpoint 的老配置仍可用。 */
  endpoint: string
  /**
   * 有序端点列表（新配置）。读路径按顺序尝试，可回落到下一个；
   * 写路径只用第一个。缺省时从 `[endpoint]` 派生。
   */
  endpoints?: string[]
  apiKey: string
  serviceId: string
  teamId: string
  agentId: string
  userId: string
  sessionKey: string
  taskId?: string
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

export interface ConversationHit {
  id?: string
  role?: string
  content: string
  timestamp?: string
  score?: number
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
 * MemoryCore Gateway 检索端点的硬约束（v2.0.3 `/v3/atomic/search` 与 `/v3/conversation/search`）：
 *   query: z.string().min(1).max(2048) —— JS String.length，即 **UTF-16 码元**，不是码点
 *   limit: z.int().min(1).max(100)     —— 缺省 5
 * 超出即 HTTP 400（`query: Too big` / `limit: Too big`）。mcp-bridge 在客户端边缘钳制，
 * 避免长 query / 大 limit 直接打断召回（上游 issue #1928 / PR #1933 只在 hermes 客户端修过）。
 */
export const MAX_SEARCH_QUERY_CHARS = 2048
export const MIN_SEARCH_LIMIT = 1
export const MAX_SEARCH_LIMIT = 100
/** 超长 query 保留的头部码元数 */
export const SEARCH_QUERY_HEAD_CHARS = 1600
/** 超长 query 保留的尾部码元数 */
export const SEARCH_QUERY_TAIL_CHARS = 400
/** 截断标记（5 个码元）：1600 + 5 + 400 = 2005 ≤ 2048，绝不越界。 */
export const SEARCH_QUERY_ELLIPSIS = '\n...\n'

/** 检索请求的 query 钳制元信息，工具层据此回显 `_query`。 */
export interface SearchQueryInfo {
  /** 调用方传入的 query 原始 .length（UTF-16 码元） */
  original_length: number
  /** 实际发给网关的 query .length；未截断时与 original_length 相同 */
  sent_length: number
  /** 是否因超出 2048 码元上限而被截断 */
  clamped: boolean
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

/**
 * 从头部取 max 个码元，但不切断 UTF-16 代理对。
 * 若切割点正好落在高代理之后，则回退一个码元（宁可少一个字，也不产生孤立代理）。
 */
function sliceHeadSafe(text: string, max: number): string {
  let end = Math.min(max, text.length)
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return text.slice(0, end)
}

/** 从尾部取 max 个码元，同样不切断代理对（切割点落在低代理上时左移一个码元）。 */
function sliceTailSafe(text: string, max: number): string {
  let start = Math.max(0, text.length - max)
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1
  return text.slice(start)
}

/**
 * 把检索 query 钳制到网关上限。
 *
 * - `length ≤ 2048`：**逐字原样返回**（不 trim、不改写）。
 * - 超长：head 1600 码元 + `"\n...\n"` + tail 400 码元（合计 2005 码元），
 *   两端切割都不会切断 UTF-16 代理对。
 * - 空白 query（空串 / 仅空白 / 非字符串）：抛 `query is required`，调用方不得发请求。
 */
export function clampSearchQuery(query: string): string {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required')
  }
  if (query.length <= MAX_SEARCH_QUERY_CHARS) return query
  const head = sliceHeadSafe(query, SEARCH_QUERY_HEAD_CHARS)
  const tail = sliceTailSafe(query, SEARCH_QUERY_TAIL_CHARS)
  return `${head}${SEARCH_QUERY_ELLIPSIS}${tail}`
}

/**
 * 把检索 limit 钳制到网关允许的整数区间。
 *
 * - `undefined` → 返回 `undefined`，调用方继续省略该字段（沿用网关默认 5）；
 * - 非有限数 / 非数字 → 同样忽略（返回 `undefined`，不让 NaN 变成 JSON `null` 触发 400）；
 * - 其余向下取整后再钳到 `[1, 100]`（网关是 `z.int()`，2.7 必须变成 2）。
 */
export function clampSearchLimit(limit: number | undefined): number | undefined {
  if (limit == null) return undefined
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.floor(limit)))
}

/**
 * 单个端点的尝试失败。
 *
 * `fallback=true` 表示这是一次"可回落"失败：网络错误、AbortError 超时、
 * HTTP 5xx、非 JSON 响应（典型如 Cloudflare 502 HTML）——换下一个端点可能成功。
 * `fallback=false` 表示"不可回落"失败：HTTP 4xx（鉴权/参数错）或 envelope
 * `code!==0`（业务错误）——换端点也只是掩盖问题，直接抛给调用方。
 */
class EndpointAttemptError extends Error {
  constructor(
    message: string,
    readonly fallback: boolean,
  ) {
    super(message)
    this.name = 'EndpointAttemptError'
  }
}

function normalizeBaseUrl(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '')
}

/** 按顺序去重（保留第一个出现的位置）。 */
function dedupeEndpoints(endpoints: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const endpoint of endpoints) {
    if (seen.has(endpoint)) continue
    seen.add(endpoint)
    out.push(endpoint)
  }
  return out
}

function errorName(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { name?: string }).name : undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * v3 strict-isolation 数据面客户端（裸 HTTP，直连 MemoryCore Gateway）。
 *
 * 协议：
 *   - 所有请求带 `Authorization: Bearer <apiKey>` + `x-tdai-service-id: <spaceId>`
 *   - 请求体带隔离三元组 team_id / agent_id / user_id
 *   - 写路径（conversation/add）必须带 session_id
 *   - 响应为 envelope { code, message, data }，code!==0 视为失败
 *
 * 端点回落（≥0.6.0）：
 *   - 读路径（atomic/search、conversation/search、core/read、scenario/ls）按
 *     `endpoints` 顺序尝试，遇到可回落失败自动换下一个（公网 Cloudflare 抖动时
 *     优先落到 Tailscale 内网端点）。
 *   - 写路径（conversation/add）**只用第一个端点、不回落**：请求可能已到达网关，
 *     只是响应丢失；重发别的端点会造成重复写入。
 *   - 每次尝试独立使用 `timeoutMs` 的 AbortController；全部失败时抛出的错误包含
 *     每个尝试过的 endpoint 与失败原因。
 */
export class V3MemoryClient {
  private readonly endpoints: string[]
  private readonly headers: Record<string, string>
  private readonly iso: { team_id: string; agent_id: string; user_id: string; task_id?: string }
  private readonly sessionKey: string
  private readonly timeoutMs: number

  constructor(config: V3ClientConfig) {
    // 向后兼容：老配置只给 endpoint → endpoints=[endpoint]；新配置给 endpoints 时按给定顺序。
    const configured = (config.endpoints?.length ? config.endpoints : [config.endpoint])
      .map(normalizeBaseUrl)
      .filter((endpoint) => endpoint.length > 0)
    this.endpoints = dedupeEndpoints(configured.length > 0 ? configured : [normalizeBaseUrl(config.endpoint)])
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'x-tdai-service-id': config.serviceId,
    }
    this.iso = {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
      ...(config.taskId ? { task_id: config.taskId } : {}),
    }
    this.sessionKey = config.sessionKey
    this.timeoutMs = config.timeoutMs ?? 15000
  }

  /**
   * 向单个端点发起一次 POST 并读取响应文本。
   * 网络错误/超时在这里统一转换成可回落失败（EndpointAttemptError）。
   */
  private async fetchOnce(
    baseUrl: string,
    path: string,
    payload: string,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: payload,
        signal: controller.signal,
      })
      const text = await res.text()
      return { ok: res.ok, status: res.status, text }
    } catch (err) {
      if (errorName(err) === 'AbortError' || controller.signal.aborted) {
        throw new EndpointAttemptError(
          `MemoryCore ${path} timeout after ${this.timeoutMs}ms at ${baseUrl}`,
          true,
        )
      }
      throw new EndpointAttemptError(
        `MemoryCore ${path} fetch failed at ${baseUrl}: ${errorMessage(err)}`,
        true,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** 对单个端点尝试一次完整请求（含 envelope 判定）。 */
  private async postOnce<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
    const { ok, status, text } = await this.fetchOnce(baseUrl, path, JSON.stringify(body))
    let envelope: V3Envelope<T>
    try {
      envelope = JSON.parse(text) as V3Envelope<T>
    } catch {
      // HTML 502 / 网关错误页：非 JSON 一律可回落，换端点试。
      throw new EndpointAttemptError(
        `MemoryCore ${path} returned non-JSON (${status}): ${text.slice(0, 300)}`,
        true,
      )
    }
    const code = typeof envelope.code === 'number' ? envelope.code : undefined
    if (!ok) {
      // 5xx 视为端点不可用可回落；4xx 是请求/鉴权错，换端点也一样，直接抛。
      throw new EndpointAttemptError(
        `MemoryCore ${path} error (${status}${code !== undefined ? ` code=${code}` : ''}): ${envelope.message ?? text.slice(0, 300)}`,
        status >= 500,
      )
    }
    if (code !== undefined && code !== 0) {
      // 业务错误（envelope code!==0）不可回落：问题不在端点可用性，回落只会重复业务失败。
      throw new EndpointAttemptError(
        `MemoryCore ${path} error (${status} code=${code}): ${envelope.message ?? text.slice(0, 300)}`,
        false,
      )
    }
    return (envelope.data ?? {}) as T
  }

  /**
   * 按端点顺序发送请求。
   *
   * @param allowFallback 读路径 true（依次尝试）；写路径 false（只用第一个端点）。
   */
  private async post<T>(path: string, body: Record<string, unknown>, allowFallback = true): Promise<T> {
    const targets = allowFallback ? this.endpoints : this.endpoints.slice(0, 1)
    const attempts: Array<{ endpoint: string; message: string }> = []
    for (let i = 0; i < targets.length; i++) {
      const baseUrl = targets[i]!
      try {
        return await this.postOnce<T>(baseUrl, path, body)
      } catch (err) {
        if (!(err instanceof EndpointAttemptError) || !err.fallback) throw err
        attempts.push({ endpoint: baseUrl, message: err.message })
        const next = targets[i + 1]
        if (next) {
          // 只能写 stderr：stdout 是 MCP stdio 协议的帧通道，写日志会破坏协议。
          process.stderr.write(
            `mcp-bridge: ${path} via ${baseUrl} failed (${err.message}); falling back to ${next}\n`,
          )
        }
      }
    }
    const tried = attempts.map((a) => `${a.endpoint} → ${a.message}`).join('; ')
    const scope = allowFallback ? '' : ' (write path: only the first endpoint is used, no fallback)'
    throw new Error(
      `MemoryCore ${path} failed after trying ${attempts.length} endpoint(s)${scope}: ${tried}`,
    )
  }

  private baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...this.iso, ...extra }
  }

  /** 写 L0：把一段对话写入短期记忆（只走第一个端点，不回落，避免重复写入） */
  addConversation(messages: MemoryMessage[], sessionId?: string): Promise<ConversationAddData> {
    const sid = sessionId ?? this.sessionKey
    if (!sid) throw new Error('addConversation requires a session_id')
    return this.post('/v3/conversation/add', this.baseBody({ session_id: sid, messages }), false)
  }

  /** 查 L1：语义搜索原子事实 */
  async searchAtomic(
    query: string,
    opts: { limit?: number; type?: string; sessionId?: string } = {},
  ): Promise<{ items?: AtomicItem[]; query: SearchQueryInfo }> {
    // 网关契约 query≤2048 码元 / limit 1..100；空白 query 在这里就抛错，不浪费一次 400。
    const sentQuery = clampSearchQuery(query)
    const queryInfo: SearchQueryInfo = {
      original_length: query.length,
      sent_length: sentQuery.length,
      clamped: sentQuery !== query,
    }
    const body = this.baseBody({
      session_id: opts.sessionId ?? this.sessionKey,
      query: sentQuery,
      limit: clampSearchLimit(opts.limit),
      type: opts.type,
    })
    for (const k of ['limit', 'type']) if (body[k] === undefined) delete body[k]
    const data = await this.post<{ items?: AtomicItem[] }>('/v3/atomic/search', body)
    return { ...data, query: queryInfo }
  }

  /** 搜 L0：检索原始对话（BM25 + 向量） */
  async searchConversations(
    query: string,
    opts: { limit?: number; sessionId?: string } = {},
  ): Promise<{ messages?: ConversationHit[]; query: SearchQueryInfo }> {
    // 与 /v3/conversation/search 的语义保持一致：**不传 session_id 即跨 session 检索**，
    // 传了才把结果限制在该会话内。L1 抽取是异步的，L0 搜索是"刚说过的话"的兜底通道。
    // 该端点与 /v3/atomic/search 共享同一套校验：query≤2048 码元、limit 1..100。
    const sentQuery = clampSearchQuery(query)
    const queryInfo: SearchQueryInfo = {
      original_length: query.length,
      sent_length: sentQuery.length,
      clamped: sentQuery !== query,
    }
    const body: Record<string, unknown> = { query: sentQuery, limit: clampSearchLimit(opts.limit) }
    if (body.limit === undefined) delete body.limit
    if (opts.sessionId) body.session_id = opts.sessionId
    const data = await this.post<{ messages?: ConversationHit[] }>(
      '/v3/conversation/search',
      this.baseBody(body),
    )
    return { ...data, query: queryInfo }
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
