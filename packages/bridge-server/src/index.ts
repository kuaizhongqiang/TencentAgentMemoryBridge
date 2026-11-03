import express from 'express'
import { loadConfig } from './config.js'
import { authMiddleware } from './middleware/auth.js'
import { loggerMiddleware } from './middleware/logger.js'
import { createProxyHandler } from './handlers/proxy.js'
import { createV3ProxyHandler } from './handlers/v3-proxy.js'
import { resolveTailscaleIpv4 } from './tailscale.js'
import { closeAllServers, resolveListenTargets, startListening } from './listen.js'

const proxyEndpoints = [
  'recall',
  'capture',
  'search/memories',
  'search/conversations',
  'session/end',
]

async function main(): Promise<void> {
  const config = loadConfig()
  const app = express()

  app.use(express.json())

  // Health check before auth — unauthenticated. Prefer the v3 gateway when the
  // bridge is deployed as a v3 front door.
  const healthUpstreamUrl = config.v3Upstream ?? config.tencentDbUrl
  app.get('/health', async (_req, res) => {
    try {
      const upstream = await fetch(`${healthUpstreamUrl}/health`, { method: 'GET' })
      const upstreamOk = upstream.ok ? 'reachable' : 'error'
      res.json({ status: 'ok', upstream: upstreamOk })
    } catch {
      res.json({ status: 'ok', upstream: 'unreachable' })
    }
  })

  // Transparent /v3/* proxy: mounted BEFORE legacy auth on purpose — the
  // MemoryCore gateway authenticates v3 with its own Bearer apiKey, so the
  // bridge must not require the legacy shared key.
  if (config.v3Upstream) {
    app.use(
      '/v3',
      createV3ProxyHandler({
        upstream: config.v3Upstream,
        timeoutMs: config.v3ProxyTimeoutMs,
      }),
    )
    console.log(
      `Transparently proxying /v3/* to ${config.v3Upstream} (timeout ${config.v3ProxyTimeoutMs}ms)`,
    )
  }

  app.use(authMiddleware(config.agents, { mode: config.authMode }))
  app.use(loggerMiddleware)

  const proxyHandler = createProxyHandler(config.tencentDbUrl)
  for (const endpoint of proxyEndpoints) {
    app.post(`/api/v1/${endpoint}`, proxyHandler)
  }

  console.log(`Bridge server listen mode: ${config.listenMode}`)
  console.log(`Forwarding legacy /api/v1/* to ${config.tencentDbUrl}`)
  console.log(`Legacy auth mode: ${config.authMode}`)

  const targets = await resolveListenTargets(config, { resolveTailscaleIpv4 })
  const { servers } = await startListening(app, targets)

  let shuttingDown = false
  function shutdown(signal: string): void {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Received ${signal}, shutting down...`)
    const forceTimer = setTimeout(() => {
      console.error('Forced shutdown after 5s timeout')
      process.exit(1)
    }, 5000)
    forceTimer.unref()

    closeAllServers(servers)
      .then(() => {
        console.log('All servers closed')
        process.exit(0)
      })
      .catch((err: unknown) => {
        console.error('Failed to close servers', err)
        process.exit(1)
      })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error('Failed to start bridge server:', err instanceof Error ? err.message : err)
  process.exit(1)
})
