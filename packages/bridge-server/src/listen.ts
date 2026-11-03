import type { Express } from 'express'
import type { AppConfig } from './config.js'

/**
 * Type of the HTTP server returned by `app.listen`.
 *
 * Derived from Express instead of importing `node:http`'s `Server` so it stays
 * consistent with whatever `@types/node` version the caller resolved (this
 * monorepo can end up with two copies via transitive dependencies; mixing
 * their `Server` identities makes `off()` / event-listener types incompatible).
 */
export type ListenServer = ReturnType<Express['listen']>

/** One socket to bind. `host === undefined` means the historical wildcard listen. */
export interface ListenTarget {
  host?: string
  port: number
}

export interface RunningListeners {
  servers: ListenServer[]
  addresses: Array<{ address: string; port: number }>
}

export interface ListenDeps {
  /** Resolve the local Tailscale IPv4; injectable so tests never touch a real tailnet. */
  resolveTailscaleIpv4: () => Promise<string>
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Turn the listen mode + explicit host list into concrete bind targets.
 *
 * - `wan` without `LISTEN_HOSTS`/`HOST` → wildcard listen (exact legacy behavior).
 * - `wan` with explicit hosts → one server per host (public/WAN interfaces only).
 * - `tailscale` → only the Tailscale IPv4 (resolved at runtime, never hardcoded).
 * - `both` → explicit hosts + Tailscale IPv4, de-duplicated. Config validation
 *   guarantees at least one explicit host, so `both` can never silently degrade
 *   to a tailnet-only listener.
 */
export async function resolveListenTargets(
  config: Pick<AppConfig, 'port' | 'listenMode' | 'listenHosts'>,
  deps: ListenDeps,
): Promise<ListenTarget[]> {
  const port = config.port

  if (config.listenMode === 'wan') {
    if (config.listenHosts.length === 0) return [{ port }]
    return config.listenHosts.map((host) => ({ host, port }))
  }

  if (config.listenMode === 'tailscale') {
    return [{ host: await deps.resolveTailscaleIpv4(), port }]
  }

  // both
  if (config.listenHosts.length === 0) {
    throw new Error(
      'LISTEN_MODE=both requires at least one explicit public interface via ' +
        'LISTEN_HOSTS or HOST; use LISTEN_MODE=wan for wildcard-only listening',
    )
  }
  const tailscaleIp = await deps.resolveTailscaleIpv4()
  return dedupe([...config.listenHosts, tailscaleIp]).map((host) => ({ host, port }))
}

function listenOne(app: Express, target: ListenTarget): Promise<ListenServer> {
  return new Promise<ListenServer>((resolve, reject) => {
    const server =
      target.host === undefined ? app.listen(target.port) : app.listen(target.port, target.host)

    // First event wins. Using an explicit `settled` flag (instead of `off()`)
    // keeps this file free of cross-`@types/node` EventEmitter identity issues
    // while still ignoring the late `error`/`listening` event of the loser.
    let settled = false
    server.once('error', (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    })
    server.once('listening', () => {
      if (settled) return
      settled = true
      resolve(server)
    })
  })
}

/**
 * Bind every target sequentially (same port). Logs the *actual* bound address
 * from `server.address()` rather than echoing config. If any bind fails, the
 * already-open servers are closed again and the error is rethrown so the
 * process can exit non-zero.
 */
export async function startListening(
  app: Express,
  targets: ListenTarget[],
  log: (message: string) => void = console.log,
): Promise<RunningListeners> {
  const servers: ListenServer[] = []
  const addresses: Array<{ address: string; port: number }> = []

  try {
    for (const target of targets) {
      const server = await listenOne(app, target)
      servers.push(server)
      const address = server.address()
      if (address && typeof address === 'object') {
        addresses.push({ address: address.address, port: address.port })
        const label =
          target.host === undefined ? 'wildcard/all interfaces' : target.host
        log(`Listening on ${address.address}:${address.port} (target: ${label})`)
      }
    }
    return { servers, addresses }
  } catch (err) {
    await closeAllServers(servers)
    throw err
  }
}

/** Close every server gracefully; resolves once all are closed. Idempotent. */
export function closeAllServers(servers: ListenServer[]): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          try {
            // Drop idle keep-alive sockets so graceful shutdown is not held
            // hostage by a client that is not sending anything.
            server.closeIdleConnections()
          } catch {
            // older Node without closeIdleConnections
          }
          try {
            server.close(() => resolve())
          } catch {
            resolve()
          }
        }),
    ),
  ).then(() => undefined)
}
