import express from 'express'
import { loadConfig } from './config.js'
import { authMiddleware } from './middleware/auth.js'
import { loggerMiddleware } from './middleware/logger.js'
import { createProxyHandler } from './handlers/proxy.js'

const config = loadConfig()
const app = express()

app.use(express.json())

// Health check before auth — unauthenticated
app.get('/health', async (_req, res) => {
  try {
    const upstream = await fetch(`${config.tencentDbUrl}/health`, { method: 'GET' })
    const upstreamOk = upstream.ok ? 'reachable' : 'error'
    res.json({ status: 'ok', upstream: upstreamOk })
  } catch {
    res.json({ status: 'ok', upstream: 'unreachable' })
  }
})

app.use(authMiddleware(config.agents))
app.use(loggerMiddleware)

const proxyHandler = createProxyHandler(config.tencentDbUrl)

// Register all proxy endpoints
const endpoints = [
  'recall',
  'capture',
  'search/memories',
  'search/conversations',
  'session/end',
]

for (const endpoint of endpoints) {
  app.post(`/api/v1/${endpoint}`, proxyHandler)
}

app.listen(config.port, () => {
  console.log(`Bridge server listening on port ${config.port}`)
  console.log(`Forwarding to TencentDB at ${config.tencentDbUrl}`)
})

