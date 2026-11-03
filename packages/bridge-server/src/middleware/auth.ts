import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'node:crypto'
import type { AgentConfig, AuthMode } from '../config.js'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

declare global {
  namespace Express {
    interface Request {
      sender?: string
      agentConfig?: AgentConfig
    }
  }
}

export interface AuthOptions {
  /**
   * `shared-key` (default): legacy `Authorization: Bearer <key>` + `X-Sender`.
   * `tailscale`: trust `Tailscale-User-Login` injected by `tailscale serve` and
   * skip the shared key; requests without that header fall back to the legacy
   * shared-key check (never a silent bypass).
   */
  mode?: AuthMode
}

/** Header injected by `tailscale serve` for authenticated tailnet users. */
export const TAILSCALE_USER_LOGIN_HEADER = 'tailscale-user-login'

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Legacy `/api/v1/*` authentication.
 *
 * `AUTH_MODE=tailscale` is optional and off by default. It only applies to
 * legacy endpoints, only when `tailscale serve` injected `Tailscale-User-Login`:
 * the login becomes the sender and endpoint scoping is bypassed (`*`). A direct
 * tailnet connection can forge this header, so it is only trustworthy behind
 * `tailscale serve` on a controlled mesh.
 */
export function authMiddleware(agents: AgentConfig[], options: AuthOptions = {}) {
  const mode: AuthMode = options.mode ?? 'shared-key'

  return (req: Request, res: Response, next: NextFunction): void => {
    if (mode === 'tailscale') {
      const tailscaleLogin = readHeaderValue(req.headers[TAILSCALE_USER_LOGIN_HEADER])
      if (tailscaleLogin) {
        req.sender = tailscaleLogin
        req.agentConfig = {
          // Synthetic identity: authenticated by `tailscale serve`, not by a
          // shared API key, and allowed on every legacy endpoint.
          name: tailscaleLogin,
          apiKeyHash: '',
          allowedEndpoints: ['*'],
          crossDomainRecall: false,
        }
        next()
        return
      }
      // No Tailscale identity present: fall through to the legacy shared-key
      // check so existing deployments keep working unchanged.
    }

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
    req.agentConfig = agent
    next()
  }
}
