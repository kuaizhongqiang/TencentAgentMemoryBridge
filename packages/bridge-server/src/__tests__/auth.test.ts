/// <reference types="vitest/globals" />
import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentConfig, AuthMode } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'

const API_KEY = 'shared-secret'
const OLD_ENV = { ...process.env }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const agents: AgentConfig[] = [
  {
    name: 'legacy-agent',
    apiKeyHash: sha256(API_KEY),
    allowedEndpoints: ['recall'],
  },
]

const trackedServers: Server[] = []

function buildApp(mode: AuthMode) {
  const app = express()
  app.use(express.json())
  app.use(authMiddleware(agents, { mode }))
  const handler = (req: express.Request, res: express.Response) => {
    res.json({
      sender: req.sender ?? null,
      allowed: req.agentConfig?.allowedEndpoints ?? [],
    })
  }
  app.get('/api/v1/recall', handler)
  app.get('/api/v1/capture', handler)
  return app
}

async function startApp(mode: AuthMode): Promise<string> {
  const server = http.createServer(buildApp(mode))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  trackedServers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  process.env = { ...OLD_ENV }
  for (const server of trackedServers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
})

describe('authMiddleware', () => {
  it('shared-key mode: valid Bearer + X-Sender authenticates', async () => {
    const base = await startApp('shared-key')
    const response = await fetch(`${base}/api/v1/recall`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'x-sender': 'legacy-agent' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sender: 'legacy-agent',
      allowed: ['recall'],
    })
  })

  it('shared-key mode: missing Authorization is rejected', async () => {
    const base = await startApp('shared-key')
    const response = await fetch(`${base}/api/v1/recall`)
    expect(response.status).toBe(401)
  })

  it('shared-key mode: Tailscale-User-Login alone is NOT trusted', async () => {
    const base = await startApp('shared-key')
    const response = await fetch(`${base}/api/v1/recall`, {
      headers: { 'tailscale-user-login': 'alice@example.com' },
    })
    expect(response.status).toBe(401)
  })

  it('shared-key mode: wrong key is rejected', async () => {
    const base = await startApp('shared-key')
    const response = await fetch(`${base}/api/v1/recall`, {
      headers: { authorization: 'Bearer wrong', 'x-sender': 'legacy-agent' },
    })
    expect(response.status).toBe(403)
  })

  it('tailscale mode: Tailscale-User-Login authenticates without shared key', async () => {
    const base = await startApp('tailscale')
    const response = await fetch(`${base}/api/v1/recall`, {
      headers: { 'tailscale-user-login': 'alice@example.com' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sender: 'alice@example.com',
      allowed: ['*'],
    })
  })

  it('tailscale mode: login bypasses endpoint scoping', async () => {
    const base = await startApp('tailscale')
    const response = await fetch(`${base}/api/v1/capture`, {
      headers: { 'tailscale-user-login': 'alice@example.com' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sender: 'alice@example.com',
      allowed: ['*'],
    })
  })

  it('tailscale mode: falls back to shared-key when the header is absent', async () => {
    const base = await startApp('tailscale')

    const viaKey = await fetch(`${base}/api/v1/recall`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'x-sender': 'legacy-agent' },
    })
    expect(viaKey.status).toBe(200)
    expect(await viaKey.json()).toEqual({ sender: 'legacy-agent', allowed: ['recall'] })

    const anonymous = await fetch(`${base}/api/v1/recall`)
    expect(anonymous.status).toBe(401)
  })

  it('tailscale mode: still enforces endpoint scoping for shared-key fallback', async () => {
    const base = await startApp('tailscale')
    const response = await fetch(`${base}/api/v1/capture`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'x-sender': 'legacy-agent' },
    })
    expect(response.status).toBe(403)
  })

  it('tailscale mode: blank login header falls back instead of authenticating', async () => {
    const base = await startApp('tailscale')
    const response = await fetch(`${base}/api/v1/recall`, {
      headers: { 'tailscale-user-login': '   ' },
    })
    expect(response.status).toBe(401)
  })
})
