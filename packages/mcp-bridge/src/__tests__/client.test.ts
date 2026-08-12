/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import { V3MemoryClient } from '../client.js'

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
})
