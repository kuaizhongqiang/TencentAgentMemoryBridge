/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
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

describe('config: listen mode / hosts / auth / v3', () => {
  const BASE: NodeJS.ProcessEnv = { AGENTS: '[]' }

  function load(overrides: NodeJS.ProcessEnv = {}) {
    return loadConfig({ ...BASE, ...overrides })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults: wan wildcard, shared-key auth, v3 proxy disabled', () => {
    const config = load()
    expect(config.listenMode).toBe('wan')
    expect(config.listenHosts).toEqual([])
    expect(config.authMode).toBe('shared-key')
    expect(config.v3Upstream).toBeUndefined()
    expect(config.v3ProxyTimeoutMs).toBe(30_000)
  })

  it('HOST is a single-address alias for LISTEN_HOSTS', () => {
    expect(load({ HOST: '127.0.0.1' }).listenHosts).toEqual(['127.0.0.1'])
  })

  it('parses LISTEN_HOSTS: multiple hosts, trims and drops empty items', () => {
    expect(load({ LISTEN_HOSTS: ' 0.0.0.0 , 10.0.0.5 ,, ' }).listenHosts).toEqual([
      '0.0.0.0',
      '10.0.0.5',
    ])
  })

  it('de-duplicates repeated LISTEN_HOSTS entries', () => {
    expect(load({ LISTEN_HOSTS: '127.0.0.1,127.0.0.1' }).listenHosts).toEqual([
      '127.0.0.1',
    ])
  })

  it('LISTEN_HOSTS wins over HOST and warns on stderr', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = load({ HOST: '192.168.1.9', LISTEN_HOSTS: '10.1.1.1,10.1.1.2' })
    expect(config.listenHosts).toEqual(['10.1.1.1', '10.1.1.2'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('LISTEN_HOSTS')
  })

  it('falls back to HOST when LISTEN_HOSTS contains only empty items', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = load({ HOST: '127.0.0.1', LISTEN_HOSTS: ' , , ' })
    expect(config.listenHosts).toEqual(['127.0.0.1'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('TAILSCALE_LISTEN=true is equivalent to LISTEN_MODE=tailscale', () => {
    expect(load({ TAILSCALE_LISTEN: 'true' }).listenMode).toBe('tailscale')
    expect(load({ TAILSCALE_LISTEN: 'false' }).listenMode).toBe('wan')
    expect(load({ TAILSCALE_LISTEN: 'TRUE' }).listenMode).toBe('tailscale')
  })

  it('LISTEN_MODE is parsed explicitly', () => {
    expect(load({ LISTEN_MODE: 'wan' }).listenMode).toBe('wan')
    expect(load({ LISTEN_MODE: 'tailscale' }).listenMode).toBe('tailscale')
    expect(load({ LISTEN_MODE: 'both', HOST: '0.0.0.0' }).listenMode).toBe('both')
  })

  it('warns that LISTEN_HOSTS is ignored in tailscale-only mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = load({ LISTEN_MODE: 'tailscale', LISTEN_HOSTS: '0.0.0.0' })
    expect(config.listenMode).toBe('tailscale')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('LISTEN_MODE=both')
  })

  it('LISTEN_MODE=both without an explicit public host fails loudly', () => {
    expect(() => load({ LISTEN_MODE: 'both' })).toThrow(/LISTEN_MODE=both/)
    expect(() => load({ LISTEN_MODE: 'both', LISTEN_HOSTS: ' , ' })).toThrow(
      /LISTEN_MODE=both/,
    )
  })

  it('rejects invalid LISTEN_MODE / TAILSCALE_LISTEN values', () => {
    expect(() => load({ LISTEN_MODE: 'public' })).toThrow(/Invalid LISTEN_MODE/)
    expect(() => load({ TAILSCALE_LISTEN: 'yes' })).toThrow(/Invalid TAILSCALE_LISTEN/)
  })

  it('rejects contradictory LISTEN_MODE=wan + TAILSCALE_LISTEN=true', () => {
    expect(() => load({ LISTEN_MODE: 'wan', TAILSCALE_LISTEN: 'true' })).toThrow(
      /Conflicting listen configuration/,
    )
  })

  it('parses AUTH_MODE, defaulting to shared-key', () => {
    expect(load({ AUTH_MODE: 'tailscale' }).authMode).toBe('tailscale')
    expect(load({ AUTH_MODE: 'shared-key' }).authMode).toBe('shared-key')
    expect(load({ AUTH_MODE: '  ' }).authMode).toBe('shared-key')
    expect(() => load({ AUTH_MODE: 'none' })).toThrow(/Invalid AUTH_MODE/)
  })

  it('parses and normalizes V3_UPSTREAM', () => {
    expect(load({ V3_UPSTREAM: 'http://127.0.0.1:8422/' }).v3Upstream).toBe(
      'http://127.0.0.1:8422',
    )
    expect(load({ V3_UPSTREAM: 'https://memory.example.com/base/' }).v3Upstream).toBe(
      'https://memory.example.com/base',
    )
    expect(load({ V3_UPSTREAM: '' }).v3Upstream).toBeUndefined()
  })

  it('rejects invalid V3_UPSTREAM values', () => {
    expect(() => load({ V3_UPSTREAM: 'not-a-url' })).toThrow(/Invalid V3_UPSTREAM/)
    expect(() => load({ V3_UPSTREAM: 'ftp://127.0.0.1:8422' })).toThrow(
      /Invalid V3_UPSTREAM/,
    )
  })

  it('parses V3_PROXY_TIMEOUT_MS as a positive integer', () => {
    expect(load({ V3_PROXY_TIMEOUT_MS: '5000' }).v3ProxyTimeoutMs).toBe(5000)
    expect(load({ V3_PROXY_TIMEOUT_MS: ' ' }).v3ProxyTimeoutMs).toBe(30_000)
    expect(() => load({ V3_PROXY_TIMEOUT_MS: 'abc' })).toThrow(
      /Invalid V3_PROXY_TIMEOUT_MS/,
    )
    expect(() => load({ V3_PROXY_TIMEOUT_MS: '0' })).toThrow(
      /Invalid V3_PROXY_TIMEOUT_MS/,
    )
    expect(() => load({ V3_PROXY_TIMEOUT_MS: '-1' })).toThrow(
      /Invalid V3_PROXY_TIMEOUT_MS/,
    )
  })
})
