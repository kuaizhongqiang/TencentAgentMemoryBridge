import type { Request, Response } from 'express'

const TENCDB_ENDPOINT_MAP: Record<string, string> = {
  recall: '/recall',
  capture: '/capture',
  'search/memories': '/search/memories',
  'search/conversations': '/search/conversations',
  'session/end': '/session/end',
}

export function createProxyHandler(tencentDbUrl: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const endpoint = req.path.replace(/^\/api\/v1\//, '')
    const targetPath = TENCDB_ENDPOINT_MAP[endpoint]

    if (!targetPath) {
      res.status(404).json({ error: `Unknown endpoint: ${endpoint}` })
      return
    }

    const targetUrl = `${tencentDbUrl}${targetPath}`

    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sender': req.sender ?? 'unknown',
        },
        body: JSON.stringify(req.body),
      })

      const data = await upstream.json()
      res.status(upstream.status).json(data)
    } catch (err) {
      console.error(`Proxy error [${endpoint}]:`, err)
      res.status(502).json({ error: 'Upstream request failed' })
    }
  }
}
