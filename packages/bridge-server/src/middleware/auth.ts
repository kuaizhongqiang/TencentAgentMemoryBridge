import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'node:crypto'
import type { AgentConfig } from '../config.js'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

declare global {
  namespace Express {
    interface Request {
      sender?: string
    }
  }
}

export function authMiddleware(agents: AgentConfig[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    const apiKey = authHeader.slice(7)
    const keyHash = hashKey(apiKey)
    const sender = req.headers['x-sender'] as string | undefined

    if (!sender) {
      res.status(400).json({ error: 'Missing X-Sender header' })
      return
    }

    const agent = agents.find((a) => a.apiKeyHash === keyHash && a.name === sender)
    if (!agent) {
      res.status(403).json({ error: 'Invalid API key or sender' })
      return
    }

    // Infer endpoint name from the URL path
    const path = req.path.replace(/^\/api\/v1\//, '')
    if (!agent.allowedEndpoints.includes(path) && !agent.allowedEndpoints.includes('*')) {
      res.status(403).json({ error: `Endpoint not allowed for sender: ${sender}` })
      return
    }

    req.sender = sender
    next()
  }
}
