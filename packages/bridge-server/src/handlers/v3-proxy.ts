import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'

export interface V3ProxyOptions {
  /** Upstream base URL, e.g. `http://127.0.0.1:8422` (no trailing slash required). */
  upstream: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable for tests; defaults to `console.error` (stderr). */
  logError?: (message: string, err?: unknown) => void
}

/** Headers that must survive the bridge hop (v3 auth + content negotiation). */
const FORWARDED_HEADERS = [
  'authorization',
  'x-tdai-service-id',
  'content-type',
  'accept',
] as const

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function normalizeUpstream(upstream: string): string {
  return upstream.replace(/\/+$/, '')
}

/**
 * Transparent reverse proxy for MemoryCore `/v3/*`.
 *
 * The bridge deliberately does **not** authenticate `/v3/*` itself: the v3
 * gateway still enforces `Authorization: Bearer <apiKey>`, so duplicating auth
 * here would only add another key to rotate. This handler must therefore be
 * mounted **before** the legacy `authMiddleware`, and the listener should keep
 * `/v3/*` on the Tailscale interface only.
 *
 * Request bodies are re-serialized from `express.json()`; the proxy only
 * supports JSON request bodies and answers 400 for anything else instead of
 * silently dropping the body.
 */
export function createV3ProxyHandler(
  options: V3ProxyOptions,
): (req: ExpressRequest, res: ExpressResponse) => Promise<void> {
  const upstream = normalizeUpstream(options.upstream)
  const fetchImpl = options.fetchImpl ?? fetch
  const logError =
    options.logError ??
    ((message: string, err?: unknown) => {
      // Keep stderr concise: one line per failure, no stack traces on every
      // upstream hiccup (the message already carries method/path/target).
      if (err === undefined) console.error(message)
      else console.error(`${message}: ${err instanceof Error ? err.message : String(err)}`)
    })

  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const pathWithQuery = req.originalUrl || req.url
    const targetUrl = `${upstream}${pathWithQuery}`

    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }

    let body: string | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) {
        body = JSON.stringify(req.body)
        if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
      } else {
        const contentLength = req.headers['content-length']
        const chunked = req.headers['transfer-encoding'] !== undefined
        if (chunked || (contentLength !== undefined && Number(contentLength) > 0)) {
          res.status(400).json({
            error: 'v3 proxy only supports JSON request bodies',
          })
          return
        }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let upstreamResponse: Response
    try {
      upstreamResponse = await fetchImpl(targetUrl, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      })
    } catch (err) {
      const timedOut = controller.signal.aborted
      const detail = errorMessage(err)
      logError(
        `[v3-proxy] ${req.method} ${pathWithQuery} -> ${targetUrl} failed` +
          (timedOut ? ` (timeout after ${options.timeoutMs}ms)` : ''),
        err,
      )
      res.status(502).json({
        error: timedOut ? 'V3 upstream timed out' : 'V3 upstream request failed',
        upstream,
        detail,
      })
      return
    } finally {
      clearTimeout(timer)
    }

    let text: string
    try {
      text = await upstreamResponse.text()
    } catch (err) {
      logError(`[v3-proxy] reading upstream response body failed for ${targetUrl}`, err)
      res.status(502).json({
        error: 'V3 upstream response could not be read',
        upstream,
        detail: errorMessage(err),
      })
      return
    }

    res.status(upstreamResponse.status)
    const contentType = upstreamResponse.headers.get('content-type')
    if (contentType) res.setHeader('content-type', contentType)
    res.send(text)
  }
}
