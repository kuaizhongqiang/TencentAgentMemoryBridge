/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AppConfig } from '../config.js'
import { closeAllServers, resolveListenTargets, startListening } from '../listen.js'

type PlanConfig = Pick<AppConfig, 'port' | 'listenMode' | 'listenHosts'>

const TAILSCALE_IP = '100.87.60.42'

function plan(overrides: Partial<PlanConfig> = {}) {
  const config: PlanConfig = {
    port: 3000,
    listenMode: 'wan',
    listenHosts: [],
    ...overrides,
  }
  return resolveListenTargets(config, {
    resolveTailscaleIpv4: async () => TAILSCALE_IP,
  })
}

async function getFreePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => (err ? reject(err) : resolve()))
  })
  return address.port
}

function buildPingApp() {
  const app = express()
  app.get('/ping', (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('resolveListenTargets', () => {
  it('mode=wan with no explicit hosts keeps the legacy wildcard listen', async () => {
    expect(await plan()).toEqual([{ port: 3000 }])
  })

  it('mode=wan with explicit hosts binds each host on the same port', async () => {
    expect(await plan({ listenHosts: ['0.0.0.0', '10.0.0.5'] })).toEqual([
      { host: '0.0.0.0', port: 3000 },
      { host: '10.0.0.5', port: 3000 },
    ])
  })

  it('mode=tailscale binds only the resolved Tailscale IPv4', async () => {
    expect(await plan({ listenMode: 'tailscale' })).toEqual([
      { host: TAILSCALE_IP, port: 3000 },
    ])
  })

  it('mode=both binds explicit hosts plus Tailscale, de-duplicated', async () => {
    expect(
      await plan({
        listenMode: 'both',
        listenHosts: ['0.0.0.0', TAILSCALE_IP],
      }),
    ).toEqual([
      { host: '0.0.0.0', port: 3000 },
      { host: TAILSCALE_IP, port: 3000 },
    ])
  })

  it('mode=both without explicit hosts refuses to start', async () => {
    await expect(plan({ listenMode: 'both' })).rejects.toThrow(/LISTEN_MODE=both/)
  })

  it('propagates Tailscale resolution failures instead of degrading', async () => {
    await expect(
      resolveListenTargets(
        { port: 3000, listenMode: 'tailscale', listenHosts: [] },
        {
          resolveTailscaleIpv4: async () => {
            throw new Error('Unable to resolve the Tailscale IPv4')
          },
        },
      ),
    ).rejects.toThrow(/Unable to resolve the Tailscale IPv4/)
  })
})

describe('startListening / closeAllServers', () => {
  it('serves the same app on 127.0.0.1 and 127.0.0.2 with one port', async () => {
    const port = await getFreePort()
    const logs: string[] = []
    const { servers, addresses } = await startListening(
      buildPingApp(),
      [
        { host: '127.0.0.1', port },
        { host: '127.0.0.2', port },
      ],
      (message) => logs.push(message),
    )
    try {
      expect(servers).toHaveLength(2)
      expect(addresses.map((address) => address.address).sort()).toEqual([
        '127.0.0.1',
        '127.0.0.2',
      ])
      expect(logs).toHaveLength(2)
      expect(logs[0]).toContain('127.0.0.1')

      const [loopback, secondary] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/ping`),
        fetch(`http://127.0.0.2:${port}/ping`),
      ])
      expect(loopback.status).toBe(200)
      expect(secondary.status).toBe(200)
      expect(await loopback.json()).toEqual({ ok: true })
      expect(await secondary.json()).toEqual({ ok: true })
    } finally {
      await closeAllServers(servers)
    }
    expect(servers.every((server) => !server.listening)).toBe(true)
    // closeAllServers is idempotent.
    await expect(closeAllServers(servers)).resolves.toBeUndefined()
  })

  it('default wildcard target still listens on all interfaces (port 0 probe)', async () => {
    const { servers, addresses } = await startListening(
      buildPingApp(),
      [{ port: 0 }],
      () => {},
    )
    try {
      expect(addresses).toHaveLength(1)
      const address = addresses[0]
      expect(address).toBeDefined()
      const base = `http://127.0.0.1:${address!.port}/ping`
      const response = await fetch(base)
      expect(response.status).toBe(200)
    } finally {
      await closeAllServers(servers)
    }
  })

  it('closes already-started servers and rethrows when a later bind fails', async () => {
    const port = await getFreePort()
    await expect(
      startListening(
        buildPingApp(),
        [
          { host: '127.0.0.1', port },
          { host: '127.0.0.1', port },
        ],
        () => {},
      ),
    ).rejects.toThrow(/EADDRINUSE/)

    // If the first server had leaked, this rebind would fail too.
    const probe = http.createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => {
      probe.close(() => resolve())
    })
  })
})
