import express from 'express'
import { loadConfig } from './config.js'
import { authMiddleware } from './middleware/auth.js'
import { loggerMiddleware } from './middleware/logger.js'
import { createProxyHandler } from './handlers/proxy.js'

const config = loadConfig()
const app = express()

app.use(express.json())
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

