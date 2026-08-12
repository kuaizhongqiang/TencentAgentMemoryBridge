/// <reference types="vitest/globals" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    process.env.MEMORY_ENDPOINT = 'https://memory.kuai-private.top'
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
})
