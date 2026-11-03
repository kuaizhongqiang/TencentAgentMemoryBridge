/// <reference types="vitest/globals" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    process.env.MEMORY_ENDPOINT = 'https://memory.kuai-private.top'
    delete process.env.MEMORY_ENDPOINTS
    process.env.API_KEY = 'sk-gate'
    process.env.SERVICE_ID = 'default'
    process.env.TEAM_ID = 'team-test'
    process.env.AGENT_ID = 'agt-test'
    process.env.USER_ID = 'usr-test'
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it('returns config when all required env vars are set', () => {
    const config = loadConfig()
    expect(config.endpoint).toBe('https://memory.kuai-private.top')
    expect(config.apiKey).toBe('sk-gate')
    expect(config.serviceId).toBe('default')
    expect(config.teamId).toBe('team-test')
    expect(config.agentId).toBe('agt-test')
    expect(config.userId).toBe('usr-test')
  })

  it('generates session key from agent id + date when SESSION_KEY unset', () => {
    delete process.env.SESSION_KEY
    const config = loadConfig()
    const today = new Date().toISOString().slice(0, 10)
    expect(config.sessionKey).toBe(`agt-test-${today}`)
  })

  it('uses provided SESSION_KEY when set', () => {
    process.env.SESSION_KEY = 'my-session'
    const config = loadConfig()
    expect(config.sessionKey).toBe('my-session')
  })

  it('uses TASK_ID when set', () => {
    process.env.TASK_ID = 'projA'
    const config = loadConfig()
    expect(config.taskId).toBe('projA')
  })

  it('derives task_id from cwd when TASK_ID unset', () => {
    delete process.env.TASK_ID
    const config = loadConfig()
    const expected = process.cwd().split(/[\\/]/).filter(Boolean).pop()
    expect(config.taskId).toBe(expected)
  })

  it('rejects an agent id (agt-*) as TASK_ID', () => {
    process.env.TASK_ID = 'agt-25k8snomqe'
    expect(() => loadConfig()).toThrow(/must NOT be an identity id/)
  })

  it('rejects a team id (team-*) as TASK_ID', () => {
    process.env.TASK_ID = 'team-w7eai9w6kc'
    expect(() => loadConfig()).toThrow(/must NOT be an identity id/)
  })

  it('rejects a user id (usr-*) as TASK_ID', () => {
    process.env.TASK_ID = 'usr-w7easao7jg'
    expect(() => loadConfig()).toThrow(/must NOT be an identity id/)
  })

  it('rejects a user key (sk-mem-*) as TASK_ID', () => {
    process.env.TASK_ID = 'sk-mem-9hOykh5a1okxrVDRWsN3l_5jWNrK4hN6'
    expect(() => loadConfig()).toThrow(/must NOT be an identity id/)
  })

  it('rejects an empty TASK_ID', () => {
    process.env.TASK_ID = '   '
    expect(() => loadConfig()).toThrow(/empty string/)
  })

  it('reads optional USER_KEY', () => {
    process.env.USER_KEY = 'sk-mem-agent'
    expect(loadConfig().userKey).toBe('sk-mem-agent')
    delete process.env.USER_KEY
    expect(loadConfig().userKey).toBeUndefined()
  })

  it('defaults timeoutMs to 15000', () => {
    delete process.env.TIMEOUT_MS
    expect(loadConfig().timeoutMs).toBe(15000)
  })

  it('throws when a required env var is missing', () => {
    delete process.env.TEAM_ID
    expect(() => loadConfig()).toThrow('TEAM_ID')
  })

  it('lists all missing vars in the error', () => {
    delete process.env.TEAM_ID
    delete process.env.AGENT_ID
    expect(() => loadConfig()).toThrow(/TEAM_ID, AGENT_ID/)
  })

  it('derives endpoints=[endpoint] from MEMORY_ENDPOINT for backward compatibility', () => {
    const config = loadConfig()
    expect(config.endpoints).toEqual(['https://memory.kuai-private.top'])
    // 兼容字段 endpoint = endpoints[0]
    expect(config.endpoint).toBe(config.endpoints[0])
  })

  it('parses MEMORY_ENDPOINTS in order, trimming spaces and dropping empty entries', () => {
    process.env.MEMORY_ENDPOINTS = ' http://100.64.0.5:3000 , , https://memory.kuai-private.top '
    const config = loadConfig()
    expect(config.endpoints).toEqual(['http://100.64.0.5:3000', 'https://memory.kuai-private.top'])
    expect(config.endpoint).toBe('http://100.64.0.5:3000')
  })

  it('dedupes repeated MEMORY_ENDPOINTS entries while preserving order', () => {
    process.env.MEMORY_ENDPOINTS = 'https://a.example,https://b.example,https://a.example/'
    // 尾斜杠不同的不算重复（客户端归一化，配置层保留原样）
    expect(loadConfig().endpoints).toEqual(['https://a.example', 'https://b.example', 'https://a.example/'])
  })

  it('MEMORY_ENDPOINTS takes precedence over MEMORY_ENDPOINT', () => {
    process.env.MEMORY_ENDPOINTS = 'http://100.64.0.5:3000,https://memory.kuai-private.top'
    const config = loadConfig()
    expect(config.endpoints).toEqual(['http://100.64.0.5:3000', 'https://memory.kuai-private.top'])
    expect(config.endpoint).toBe('http://100.64.0.5:3000')
  })

  it('falls back to MEMORY_ENDPOINT when MEMORY_ENDPOINTS is blank', () => {
    process.env.MEMORY_ENDPOINTS = '  ,  , '
    const config = loadConfig()
    expect(config.endpoints).toEqual(['https://memory.kuai-private.top'])
    expect(config.endpoint).toBe('https://memory.kuai-private.top')
  })

  it('accepts only http(s) MEMORY_ENDPOINTS entries', () => {
    process.env.MEMORY_ENDPOINTS = 'https://memory.kuai-private.top,ftp://bad.example'
    expect(() => loadConfig()).toThrow(/Invalid MEMORY_ENDPOINTS entry 'ftp:\/\/bad\.example'/)

    process.env.MEMORY_ENDPOINTS = 'not-a-url'
    expect(() => loadConfig()).toThrow(/Invalid MEMORY_ENDPOINTS entry 'not-a-url'/)

    process.env.MEMORY_ENDPOINTS = 'https://ok.example,http://ok2.example:3000'
    expect(loadConfig().endpoints).toEqual(['https://ok.example', 'http://ok2.example:3000'])
  })

  it('throws MEMORY_ENDPOINT when neither MEMORY_ENDPOINT nor MEMORY_ENDPOINTS is set', () => {
    delete process.env.MEMORY_ENDPOINT
    expect(() => loadConfig()).toThrow(/Missing required environment variable\(s\): MEMORY_ENDPOINT/)
  })

  it('allows MEMORY_ENDPOINTS without MEMORY_ENDPOINT', () => {
    delete process.env.MEMORY_ENDPOINT
    process.env.MEMORY_ENDPOINTS = 'http://100.64.0.5:3000,https://memory.kuai-private.top'
    const config = loadConfig()
    expect(config.endpoints).toHaveLength(2)
    expect(config.endpoint).toBe('http://100.64.0.5:3000')
  })
})
