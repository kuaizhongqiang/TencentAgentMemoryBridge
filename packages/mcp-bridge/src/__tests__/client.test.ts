/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  V3MemoryClient,
  clampSearchQuery,
  clampSearchLimit,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  SEARCH_QUERY_HEAD_CHARS,
  SEARCH_QUERY_TAIL_CHARS,
  SEARCH_QUERY_ELLIPSIS,
} from '../client.js'

const CONFIG = {
  endpoint: 'https://memory.kuai-private.top',
  apiKey: 'sk-gate',
  serviceId: 'default',
  teamId: 'team-test',
  agentId: 'agt-test',
  userId: 'usr-test',
  sessionKey: 'agt-test-2026-08-12',
  taskId: 'TencentAgentMemoryBridge',
  timeoutMs: 5000,
}

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** true 表示字符串里存在孤立代理（高代理后没有低代理，或低代理前没有高代理）。 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

const CLAMPED_LENGTH = SEARCH_QUERY_HEAD_CHARS + SEARCH_QUERY_ELLIPSIS.length + SEARCH_QUERY_TAIL_CHARS

describe('V3MemoryClient', () => {
  it('addConversation sends isolation triple + session_id + messages', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { accepted_ids: ['m1'], total_count: 1 } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const res = await client.addConversation([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])

    expect(res.accepted_ids).toEqual(['m1'])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://memory.kuai-private.top/v3/conversation/add')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-gate')
    expect((init.headers as Record<string, string>)['x-tdai-service-id']).toBe('default')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      team_id: 'team-test',
      agent_id: 'agt-test',
      user_id: 'usr-test',
      task_id: 'TencentAgentMemoryBridge',
      session_id: 'agt-test-2026-08-12',
    })
    expect(body.messages).toHaveLength(2)
  })

  it('searchAtomic omits undefined limit/type', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { items: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    await client.searchAtomic('query', {})

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ query: 'query', session_id: CONFIG.sessionKey })
    expect(body).not.toHaveProperty('limit')
    expect(body).not.toHaveProperty('type')
  })

  it('searchConversations omits session_id by default (cross-session search)', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { messages: [{ id: 'm1', role: 'user', content: 'hi' }] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const res = await client.searchConversations('hi', {})

    expect(res.messages).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://memory.kuai-private.top/v3/conversation/search')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      query: 'hi',
      team_id: 'team-test',
      agent_id: 'agt-test',
      user_id: 'usr-test',
      task_id: 'TencentAgentMemoryBridge',
    })
    // 不传 session_id → 跨 session 检索（L0 搜索的默认语义）
    expect(body).not.toHaveProperty('session_id')
    expect(body).not.toHaveProperty('limit')
  })

  it('searchConversations sends session_id + limit when provided', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { messages: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    await client.searchConversations('q', { limit: 3, sessionId: 'sess-1' })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ query: 'q', limit: 3, session_id: 'sess-1' })
  })

  it('throws when envelope code is non-zero', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(200, { code: 1001, message: 'invalid user_key' }))
    const client = new V3MemoryClient(CONFIG)
    await expect(client.searchAtomic('q')).rejects.toThrow(/invalid user_key/)
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(401, { message: 'Expected: Bearer {api_key}' }))
    const client = new V3MemoryClient(CONFIG)
    await expect(client.searchAtomic('q')).rejects.toThrow(/401/)
  })

  it('throws on non-JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<html>' })
    vi.stubGlobal('fetch', fetchMock)
    const client = new V3MemoryClient(CONFIG)
    await expect(client.searchAtomic('q')).rejects.toThrow(/non-JSON/)
  })

  it('searchAtomic clamps query + limit and returns query metadata', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { items: [{ id: 'a1', content: 'x' }] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const res = await client.searchAtomic('x'.repeat(5000), { limit: 999 })

    expect(res.items).toHaveLength(1)
    expect(res.query).toEqual({ original_length: 5000, sent_length: CLAMPED_LENGTH, clamped: true })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.query.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(body.query).toContain(SEARCH_QUERY_ELLIPSIS)
    expect(body.query.startsWith('x'.repeat(SEARCH_QUERY_HEAD_CHARS))).toBe(true)
    expect(body.query.endsWith('x'.repeat(SEARCH_QUERY_TAIL_CHARS))).toBe(true)
    expect(body.limit).toBe(MAX_SEARCH_LIMIT)
  })

  it('searchAtomic reports non-clamped metadata and leaves short query verbatim', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { items: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const res = await client.searchAtomic('  coffee  ', { limit: 2.7 })

    expect(res.query).toEqual({ original_length: 10, sent_length: 10, clamped: false })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.query).toBe('  coffee  ')
    expect(body.limit).toBe(2)
  })

  it('searchAtomic rejects blank query without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    await expect(client.searchAtomic('   ')).rejects.toThrow(/query is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('searchConversations applies the same clamps', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { messages: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const emojiQuery = 'x'.repeat(100) + '😀'.repeat(3000) + 'y'
    const res = await client.searchConversations(emojiQuery, { limit: 0 })

    expect(res.query.original_length).toBe(emojiQuery.length)
    expect(res.query.sent_length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(res.query.clamped).toBe(true)

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.query.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(hasLoneSurrogate(body.query)).toBe(false)
    expect(body.limit).toBe(MIN_SEARCH_LIMIT)
  })

  it('searchConversations rejects blank query without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    await expect(client.searchConversations('')).rejects.toThrow(/query is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('clampSearchQuery', () => {
  it('returns short queries verbatim (no trimming, no rewriting)', () => {
    expect(clampSearchQuery('coffee')).toBe('coffee')
    expect(clampSearchQuery('  padded query  ')).toBe('  padded query  ')
    expect(clampSearchQuery('中文查询：记忆 bridge')).toBe('中文查询：记忆 bridge')
    const exactlyMax = 'a'.repeat(MAX_SEARCH_QUERY_CHARS)
    expect(clampSearchQuery(exactlyMax)).toBe(exactlyMax)
  })

  it('clamps a 5000-char ASCII query to head + ellipsis + tail within the cap', () => {
    const clamped = clampSearchQuery('x'.repeat(5000))
    expect(clamped.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(clamped.length).toBe(CLAMPED_LENGTH)
    expect(clamped).toContain(SEARCH_QUERY_ELLIPSIS)
    expect(clamped.startsWith('x'.repeat(SEARCH_QUERY_HEAD_CHARS))).toBe(true)
    expect(clamped.endsWith('x'.repeat(SEARCH_QUERY_TAIL_CHARS))).toBe(true)
  })

  it('never splits UTF-16 surrogate pairs when clamping emoji-heavy queries', () => {
    const clamped = clampSearchQuery('😀'.repeat(3000))
    expect(clamped.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(hasLoneSurrogate(clamped)).toBe(false)
  })

  it('stays surrogate-safe on both head and tail cut boundaries', () => {
    // head 切割点落在高代理后、tail 切割点落在低代理上（两侧都需回退一个码元）
    const query = 'x'.repeat(100) + '😀'.repeat(3000) + 'y'
    const clamped = clampSearchQuery(query)
    expect(clamped.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS)
    expect(clamped).toContain(SEARCH_QUERY_ELLIPSIS)
    expect(hasLoneSurrogate(clamped)).toBe(false)
  })

  it('rejects empty / whitespace-only / non-string queries with "query is required"', () => {
    expect(() => clampSearchQuery('')).toThrow(/query is required/)
    expect(() => clampSearchQuery('   \n\t  ')).toThrow(/query is required/)
    expect(() => clampSearchQuery(undefined as unknown as string)).toThrow(/query is required/)
    expect(() => clampSearchQuery(null as unknown as string)).toThrow(/query is required/)
  })
})

describe('clampSearchLimit', () => {
  it('clamps into 1..100, floors fractions, and omits undefined/non-finite limits', () => {
    expect(clampSearchLimit(999)).toBe(MAX_SEARCH_LIMIT)
    expect(clampSearchLimit(101)).toBe(100)
    expect(clampSearchLimit(100)).toBe(100)
    expect(clampSearchLimit(1)).toBe(1)
    expect(clampSearchLimit(0)).toBe(MIN_SEARCH_LIMIT)
    expect(clampSearchLimit(-5)).toBe(1)
    expect(clampSearchLimit(2.7)).toBe(2)
    expect(clampSearchLimit(2.1)).toBe(2)
    expect(clampSearchLimit(undefined)).toBeUndefined()
    expect(clampSearchLimit(Number.NaN)).toBeUndefined()
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(clampSearchLimit(Number.NEGATIVE_INFINITY)).toBeUndefined()
  })
})
