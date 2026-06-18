import type { Request, Response } from 'express'

const TENCDB_ENDPOINT_MAP: Record<string, string> = {
  recall: '/recall',
  capture: '/capture',
  'search/memories': '/search/memories',
  'search/conversations': '/search/conversations',
  'session/end': '/session/end',
}

/** Endpoints that support sender‑domain scoping. */
const SCOPED_ENDPOINTS = new Set(['recall', 'search/memories', 'search/conversations'])

/**
 * Build the outgoing body with sender identity and permission‑aware scoping.
 *
 * Permission model:
 * - Agents with `crossDomainRecall: true` (e.g. OpenClaw) may pass arbitrary
 *   `sender` / `senders[]` values, including `senders: ["*"]`.
 * - Agents without this flag are **automatically scoped** to their own sender
 *   domain on recall/search endpoints. Any explicit `sender`/`senders` they
 *   submit that differs from their own identity is rejected.
 * - All endpoints always receive the authenticated `sender` in the body so
 *   TencentDB can tag stored memories.
 */
function buildOutgoingBody(req: Request, endpoint: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req.body }
  const ownSender = req.sender ?? 'unknown'
  const cfg = req.agentConfig

  // Always tag the authenticated sender
  body.sender = ownSender

  // Sender‑domain scoping only applies to recall/search endpoints
  if (!SCOPED_ENDPOINTS.has(endpoint)) return body

  const callerSender = req.body.sender as string | undefined
  const callerSenders = Array.isArray(req.body.senders) ? (req.body.senders as string[]) : undefined
  const hasCrossDomain = cfg?.crossDomainRecall === true

  if (hasCrossDomain) {
    // Cross‑domain agents: pass through any filter the caller specified
    if (callerSender !== undefined) body.sender = callerSender
    if (callerSenders !== undefined) body.senders = callerSenders
  } else {
    // Non‑cross‑domain agents: they can only see their own domain.
    // Any explicit filter that differs from their identity is rejected (handled
    // by the caller before calling this function). When no filter given,
    // auto‑scope to their own sender so they stay within their domain.
    if (callerSender !== undefined && callerSender !== ownSender) {
      // Will be rejected upstream — included here for error consistency
      body.sender = ownSender
    }
    if (callerSenders !== undefined) {
      const allOwn = callerSenders.length === 1 && callerSenders[0] === ownSender
      if (!allOwn) {
        // Will be rejected upstream
        delete body.senders
      }
    }
  }

  return body
}

export function createProxyHandler(tencentDbUrl: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const endpoint = req.path.replace(/^\/api\/v1\//, '')
    const targetPath = TENCDB_ENDPOINT_MAP[endpoint]

    if (!targetPath) {
      res.status(404).json({ error: `Unknown endpoint: ${endpoint}` })
      return
    }

    // Permission check: non‑cross‑domain agents cannot scope to other senders
    if (SCOPED_ENDPOINTS.has(endpoint)) {
      const cfg = req.agentConfig
      const hasCrossDomain = cfg?.crossDomainRecall === true
      const ownSender = req.sender ?? 'unknown'

      if (!hasCrossDomain) {
        const callerSender = req.body.sender as string | undefined
        const callerSenders = Array.isArray(req.body.senders)
          ? (req.body.senders as string[])
          : undefined

        if (callerSender !== undefined && callerSender !== ownSender) {
          res.status(403).json({
            error: `Sender "${ownSender}" is not allowed to recall outside its own domain`,
          })
          return
        }

        if (callerSenders !== undefined) {
          const allOwnDomain =
            callerSenders.length === 1 && callerSenders[0] === ownSender
          if (!allOwnDomain) {
            res.status(403).json({
              error: `Sender "${ownSender}" is not allowed to search outside its own domain`,
            })
            return
          }
        }
      }
    }

    const targetUrl = `${tencentDbUrl}${targetPath}`

    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sender': req.sender ?? 'unknown',
        },
        body: JSON.stringify(buildOutgoingBody(req, endpoint)),
      })

      const text = await upstream.text()
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        data = { raw: text.slice(0, 500) }
      }
      res.status(upstream.status).json(data)
    } catch (err) {
      console.error(`Proxy error [${endpoint}]:`, err)
      res.status(502).json({ error: 'Upstream request failed' })
    }
  }
}
