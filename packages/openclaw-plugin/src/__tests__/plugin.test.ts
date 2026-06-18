/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (def: any) => def,
}))

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    context: {
      pluginConfig: {
        bridgeUrl: 'http://localhost:3000/api/v1',
        apiKey: 'test',
        sender: 'openclaw',
        sessionKey: 'test-session',
      },
    },
    sessionKey: 'ctx-session',
    ...overrides,
  }
}

describe('plugin entry', () => {
  it('exports a default entry with register function', async () => {
    const mod = await import('../index.js')
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe('memory-bridge')
    expect(mod.default.name).toBe('Memory Bridge')
    expect(typeof mod.default.register).toBe('function')
  })

  it('register calls api.on with 3 hooks', async () => {
    const mod = await import('../index.js')
    const on = vi.fn()
    mod.default.register({ on })

    expect(on).toHaveBeenCalledTimes(3)
    expect(on).toHaveBeenCalledWith('before_prompt_build', expect.any(Function))
    expect(on).toHaveBeenCalledWith('agent_end', expect.any(Function))
    expect(on).toHaveBeenCalledWith('session_end', expect.any(Function))
  })

  it('before_prompt_build reads config from pluginConfig', async () => {
    const mod = await import('../index.js')
    const on = vi.fn()
    mod.default.register({ on })

    const handler = on.mock.calls.find((c: any[]) => c[0] === 'before_prompt_build')?.[1]
    const result = await handler(makeEvent())
    // Should fail because bridge server is not running
    expect(result).toBeNull()
  })

  it('before_prompt_build returns null when config is missing', async () => {
    const mod = await import('../index.js')
    const on = vi.fn()
    mod.default.register({ on })

    const handler = on.mock.calls.find((c: any[]) => c[0] === 'before_prompt_build')?.[1]
    const result = await handler(makeEvent({ context: { pluginConfig: {} } }))
    expect(result).toBeNull()
  })
})
