/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config.js'

describe('config loading', () => {
  const OLD_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it('returns default values when AGENTS is empty array', () => {
    process.env.AGENTS = '[]'
    const config = loadConfig()
    expect(config.port).toBe(3000)
    expect(config.tencentDbUrl).toBe('http://localhost:8080')
    expect(config.agents).toEqual([])
  })

  it('parses valid AGENTS JSON', () => {
    process.env.AGENTS = JSON.stringify([
      { name: 'test-agent', apiKeyHash: 'abc123', allowedEndpoints: ['recall'] },
    ])
    const config = loadConfig()
    expect(config.agents).toHaveLength(1)
    expect(config.agents[0]?.name).toBe('test-agent')
  })

  it('skips malformed agent entries without failing all agents', () => {
    process.env.AGENTS = JSON.stringify([
      { name: 'good-agent', apiKeyHash: 'abc123', allowedEndpoints: ['recall'] },
      { bad: 'entry' },
      { name: 'no-key', allowedEndpoints: [] },
    ])
    const config = loadConfig()
    expect(config.agents).toHaveLength(1)
    expect(config.agents[0]?.name).toBe('good-agent')
  })

  it('returns empty agents for invalid JSON', () => {
    process.env.AGENTS = 'not-json'
    const config = loadConfig()
    expect(config.agents).toEqual([])
  })

  it('respects PORT env var', () => {
    process.env.AGENTS = '[]'
    process.env.PORT = '9090'
    const config = loadConfig()
    expect(config.port).toBe(9090)
  })
})
