/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V3MemoryClient } from '../client.js'
import { TaskBindingStore } from '../binding.js'
import { composeBrief, digestPersona, openWorkTasks } from '../brief.js'

const CONFIG = {
  endpoint: 'https://memory.kuai-private.top',
  apiKey: 'sk-gate',
  serviceId: 'default',
  teamId: 'team-test',
  agentId: 'agt-test',
  userId: 'usr-test',
  userKey: 'uky-test',
  sessionKey: 'session-test',
  taskId: 'projA',
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

describe('TBP: client task binding + meta channel', () => {
  it('meta calls carry x-tdai-user-key; data calls do not', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { task_id: 'task-1' } })
    vi.stubGlobal('fetch', fetchMock)
    const client = new V3MemoryClient(CONFIG)

    await client.getTask('task-1')
    const [, metaInit] = fetchMock.mock.calls[0]!
    expect((metaInit.headers as Record<string, string>)['x-tdai-user-key']).toBe('uky-test')

    await client.readCore()
    const [, dataInit] = fetchMock.mock.calls[1]!
    expect((dataInit.headers as Record<string, string>)['x-tdai-user-key']).toBeUndefined()
  })

  it('meta call without userKey fails fast (no silent 401)', async () => {
    const client = new V3MemoryClient({ ...CONFIG, userKey: undefined })
    await expect(client.getTask('task-1')).rejects.toThrow(/USER_KEY/)
  })

  it('setTaskId overrides config.taskId in every data body', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: {} })
    vi.stubGlobal('fetch', fetchMock)
    const client = new V3MemoryClient(CONFIG)

    expect(client.taskSource()).toBe('config')
    client.setTaskId('task-abc')
    expect(client.taskSource()).toBe('binding')
    await client.addConversation([{ role: 'user', content: 'hi' }])
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.task_id).toBe('task-abc')

    client.setTaskId(null)
    expect(client.taskSource()).toBe('config')
    expect(client.currentTaskId()).toBe('projA')
  })

  it('atomicQuery passes type/time and omits undefined', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { items: [] } })
    vi.stubGlobal('fetch', fetchMock)
    const client = new V3MemoryClient(CONFIG)
    await client.atomicQuery({ type: 'work_task', limit: 10, time_start: '2026-01-01T00:00:00Z' })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body).toMatchObject({ type: 'work_task', limit: 10, time_start: '2026-01-01T00:00:00Z' })
    expect(body).not.toHaveProperty('offset')
  })
})

describe('TBP: binding store', () => {
  it('persists per session and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bind-'))
    const path = join(dir, 'bindings.json')
    const store = new TaskBindingStore(path)
    expect(store.get('s1')).toBeUndefined()
    store.set('s1', { task_id: 'task-1', title: 'T' })
    expect(new TaskBindingStore(path).get('s1')?.task_id).toBe('task-1')
    expect(store.clear('s1')).toBe(true)
    expect(new TaskBindingStore(path).get('s1')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('TBP: brief', () => {
  it('openWorkTasks excludes done and sorts by deadline', () => {
    const tasks = openWorkTasks([
      { id: 'a', content: 'A', type: 'work_task', priority: 80, metadata_json: '{"status":"todo","deadline":"2026-11-21T00:00:00Z"}' },
      { id: 'b', content: 'B', type: 'work_task', priority: 90, metadata_json: '{"status":"done"}' },
      { id: 'c', content: 'C', type: 'work_task', priority: 95, metadata_json: '{"status":"todo"}' },
    ])
    expect(tasks.map((task) => task.id)).toEqual(['a', 'c'])
  })

  it('digestPersona skips Scene Navigation and respects budget', () => {
    const text = '# Team\n> **Operating Thesis**: x\n## Core\n- a\n## 🗺️ Scene Navigation (Scene Index)\n### Path: a.md'
    const digest = digestPersona(text, 200)
    expect(digest).toContain('Operating Thesis')
    expect(digest).not.toContain('Scene Navigation')
    expect(digest.length).toBeLessThanOrEqual(200)
  })

  it('composeBrief fits the budget and drops scenes first', () => {
    const brief = composeBrief(
      {
        binding: { task_id: 'task-1', title: 'T' },
        persona: { content: '# Team\n> **Operating Thesis**: x\n## Core\n- a' },
        scenes: { entries: Array.from({ length: 20 }, (_, i) => ({ path: `s${i}.md`, summary: 'x'.repeat(1000) })) },
        tasks: { items: [{ id: 't1', content: 'A', type: 'work_task', metadata_json: '{"status":"todo"}' }] },
        facts: { items: [{ id: 'f1', content: 'F', type: 'work_fact' }] },
      },
      { maxChars: 2000 },
    )
    expect(brief._size_chars).toBeLessThanOrEqual(2000)
    expect(brief.scenes.every((scene) => !('summary' in scene))).toBe(true)
    expect(brief.task?.task_id).toBe('task-1')
  })
})

/** 构造一个 HTML 错误页替身（典型 Cloudflare 502）。 */
function htmlResponse(status: number, html: string) {
  return { ok: false, status, text: async () => html }
}

/** 回落时会写一行 stderr 提示（stdout 保留给 MCP 协议），测试里静音。 */
function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
}

const FALLBACK_CONFIG = {
  ...CONFIG,
  endpoints: ['https://primary.example', 'https://secondary.example'],
}

describe('TBP: meta channel 与端点策略', () => {
  it('meta 读路径（task/get）在主端点 502 时回落备用端点', async () => {
    silenceStderr()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(502, '<html><body>502 Bad Gateway</body></html>'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: { task_id: 'task-1', team_id: 'team-test', creator_user_id: 'usr-test', title: 'T' },
          }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(FALLBACK_CONFIG)
    const task = await client.getTask('task-1')

    expect(task.task_id).toBe('task-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://primary.example/v3/meta/task/get')
    expect(fetchMock.mock.calls[1]![0]).toBe('https://secondary.example/v3/meta/task/get')
    // meta 面两个端点都必须带 x-tdai-user-key（只有 Bearer 会 401）
    for (const call of fetchMock.mock.calls) {
      expect((call[1].headers as Record<string, string>)['x-tdai-user-key']).toBe('uky-test')
    }
  })

  it('meta 写路径（task/create）在主端点 502 时不回落（避免重复建任务）', async () => {
    silenceStderr()
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(502, '<html><body>502 Bad Gateway</body></html>'))
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(FALLBACK_CONFIG)
    await expect(client.createTask({ title: 'x' })).rejects.toThrow(/502|Bad Gateway/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://primary.example/v3/meta/task/create')
  })

  it('meta 写路径（task/update）同样只走第一个端点', async () => {
    silenceStderr()
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(502, '<html><body>502 Bad Gateway</body></html>'))
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(FALLBACK_CONFIG)
    await expect(client.updateTask('task-1', { status: 'completed' })).rejects.toThrow(/502|Bad Gateway/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('6000 字 query 被钳到 ≤2048，且 _query 标记 clamped', async () => {
    const fetchMock = mockFetchOnce(200, { code: 0, message: 'ok', data: { items: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const client = new V3MemoryClient(CONFIG)
    const res = await client.searchAtomic('内'.repeat(6000))

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.query.length).toBeLessThanOrEqual(2048)
    expect(res.query.original_length).toBe(6000)
    expect(res.query.sent_length).toBeLessThanOrEqual(2048)
    expect(res.query.clamped).toBe(true)
  })
})
