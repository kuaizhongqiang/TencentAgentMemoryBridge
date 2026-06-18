/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    process.env.BRIDGE_URL = 'http://localhost:3000'
    process.env.API_KEY = 'sk-test'
    process.env.SENDER = 'test-agent'
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it('returns config when all required env vars are set', () => {
    const config = loadConfig()
    expect(config.bridgeUrl).toBe('http://localhost:3000')
    expect(config.apiKey).toBe('sk-test')
    expect(config.sender).toBe('test-agent')
  })

  it('generates session_key when SESSION_KEY is not set', () => {
    delete process.env.SESSION_KEY
    const config = loadConfig()
    expect(config.sessionKey).toBeDefined()
    expect(config.sessionKey).toContain('test-agent')
  })

  it('uses provided SESSION_KEY when set', () => {
    process.env.SESSION_KEY = 'my-session'
    const config = loadConfig()
    expect(config.sessionKey).toBe('my-session')
  })

  it('throws when BRIDGE_URL is missing', () => {
    delete process.env.BRIDGE_URL
    expect(() => loadConfig()).toThrow('BRIDGE_URL')
  })

  it('throws when API_KEY is missing', () => {
    delete process.env.API_KEY
    expect(() => loadConfig()).toThrow('API_KEY')
  })

  it('throws when SENDER is missing', () => {
    delete process.env.SENDER
    expect(() => loadConfig()).toThrow('SENDER')
  })
})
