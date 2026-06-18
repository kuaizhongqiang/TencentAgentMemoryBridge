/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (def: any) => def,
}))

describe('plugin entry', () => {
  const OLD_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it('exports a default entry with register function', async () => {
    process.env.BRIDGE_URL = 'http://localhost:3000/api/v1'
    process.env.API_KEY = 'test'
    process.env.SENDER = 'openclaw'
    process.env.SESSION_KEY = 'test-session'

    const mod = await import('../index.js')
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe('memory-bridge')
    expect(mod.default.name).toBe('Memory Bridge')
    expect(typeof mod.default.register).toBe('function')
  })

  it('register handles missing env vars gracefully', async () => {
    delete process.env.BRIDGE_URL
    delete process.env.API_KEY
    delete process.env.SENDER

    const mod = await import('../index.js')
    const api = { on: vi.fn() }
    expect(() => mod.default.register(api)).not.toThrow()
  })
})
