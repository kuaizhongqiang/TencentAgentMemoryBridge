/// <reference types="vitest/globals" />
import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createV3ProxyHandler } from '../handlers/v3-proxy.js'
import { authMiddleware } from '../middleware/auth.js'

interface CapturedRequest {
  method?: string
  url?: string
  headers?: http.IncomingHttpHeaders
  body?: string
}

const trackedServers: Server[] = []

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: Server; base: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  trackedServers.push(server)
  const address = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

async function getFreePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address() as AddressInfo
  await new Promise<void>((resolve) => {
    probe.close(() => resolve())
  })
  return address.port
}

function buildBridgeApp(options: { v3Upstream?: string; timeoutMs?: number } = {}) {
  const app = express()
  app.use(express.json())
  if (options.v3Upstream) {
    app.use(
      '/v3',
      createV3ProxyHandler({
        upstream: options.v3Upstream,
        timeoutMs: options.timeoutMs ?? 5000,
      }),
    )
  }
  // Same order as production: legacy auth sits AFTER the v3 mount.
  app.use(authMiddleware([], { mode: 'shared-key' }))
  app.get('/api/v1/ping', (_req, res) => {
    res.json({ legacy: true })
  })
  return app
}

async function startBridge(options: { v3Upstream?: string; timeoutMs?: number }) {
  return startServer(buildBridgeApp(options))
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of trackedServers.splice(0)) {
    await closeServer(server)
  }
})

describe('v3 transparent proxy', () => {
  it('forwards method, path+query, auth headers and JSON body; passes status/body through', async () => {
    let captured: CapturedRequest = {}
    const upstream = await startServer(async (req, res) => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: await readBody(req),
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, items: [{ id: 'a' }] }))
    })
    const bridge = await startBridge({ v3Upstream: upstream.base })

    const requestBody = { query: '你好', limit: 5 }
    const response = await fetch(`${bridge.base}/v3/atomic/search?trace=1`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer upstream-key',
        'x-tdai-service-id': 'svc-1',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ code: 0, items: [{ id: 'a' }] })

    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('/v3/atomic/search?trace=1')
    expect(captured.headers?.authorization).toBe('Bearer upstream-key')
    expect(captured.headers?.['x-tdai-service-id']).toBe('svc-1')
    expect(captured.headers?.['content-type']).toBe('application/json')
    expect(captured.headers?.accept).toBe('application/json')
    expect(JSON.parse(captured.body ?? 'null')).toEqual(requestBody)
  })

  it('forwards GET /v3/* requests without a body', async () => {
    let captured: CapturedRequest = {}
    const upstream = await startServer(async (req, res) => {
      captured = { method: req.method, url: req.url }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const bridge = await startBridge({ v3Upstream: upstream.base })

    const response = await fetch(`${bridge.base}/v3/core/read`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe('/v3/core/read')
  })

  it('passes upstream error status and non-JSON body through unchanged', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>bad gateway</h1>')
    })
    const bridge = await startBridge({ v3Upstream: upstream.base })

    const response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe('<h1>bad gateway</h1>')
  })

  it('returns 502 JSON and logs to stderr when the upstream is unreachable', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deadPort = await getFreePort()
    const bridge = await startBridge({ v3Upstream: `http://127.0.0.1:${deadPort}` })

    const response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"x"}',
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string; upstream: string }
    expect(body.error).toBe('V3 upstream request failed')
    expect(body.upstream).toBe(`http://127.0.0.1:${deadPort}`)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('returns 502 JSON on upstream timeout', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const upstream = await startServer((_req, res) => {
      // Answer too late: the bridge must abort first.
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"late":true}')
        } catch {
          // socket already gone
        }
      }, 300)
    })
    const bridge = await startBridge({ v3Upstream: upstream.base, timeoutMs: 100 })

    const response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('V3 upstream timed out')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('rejects non-JSON request bodies instead of silently dropping them', async () => {
    let upstreamCalls = 0
    const upstream = await startServer((_req, res) => {
      upstreamCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const bridge = await startBridge({ v3Upstream: upstream.base })

    const response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'raw-body',
    })
    expect(response.status).toBe(400)
    expect(upstreamCalls).toBe(0)
  })

  it('does not require legacy auth on /v3/* but keeps /api/v1/* protected', async () => {
    let upstreamCalls = 0
    const upstream = await startServer((_req, res) => {
      upstreamCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"code":0}')
    })
    const bridge = await startBridge({ v3Upstream: upstream.base })

    const v3Response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(v3Response.status).toBe(200)
    expect(upstreamCalls).toBe(1)

    const legacyResponse = await fetch(`${bridge.base}/api/v1/ping`)
    expect(legacyResponse.status).toBe(401)
  })

  it('leaves legacy auth untouched when the v3 proxy is disabled', async () => {
    const bridge = await startBridge({})

    const response = await fetch(`${bridge.base}/v3/atomic/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })
})
