import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AgentConfig {
  name: string
  apiKeyHash: string
  allowedEndpoints: string[]
  /** Whether this sender is allowed to recall/search outside its own domain. */
  crossDomainRecall?: boolean
}

/** How the bridge binds its listening sockets. */
export type ListenMode = 'wan' | 'tailscale' | 'both'

/** How legacy `/api/v1/*` requests are authenticated. */
export type AuthMode = 'shared-key' | 'tailscale'

export interface AppConfig {
  port: number
  tencentDbUrl: string
  agents: AgentConfig[]
  /**
   * Explicit interfaces to bind (from `LISTEN_HOSTS` or `HOST`), in order.
   * Empty means "not configured": `LISTEN_MODE=wan` then falls back to the
   * historical wildcard listen, while `both` refuses to start.
   */
  listenHosts: string[]
  listenMode: ListenMode
  authMode: AuthMode
  /**
   * MemoryCore `/v3/*` gateway to transparently proxy to (e.g.
   * `http://127.0.0.1:8422`). Normalized without a trailing slash.
   * `undefined` disables the v3 proxy.
   */
  v3Upstream?: string
  /** Timeout for one `/v3/*` proxy request, in milliseconds. */
  v3ProxyTimeoutMs: number
}

const LISTEN_MODES: readonly ListenMode[] = ['wan', 'tailscale', 'both']
const AUTH_MODES: readonly AuthMode[] = ['shared-key', 'tailscale']

function parseAgent(raw: unknown): AgentConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string' || typeof obj.apiKeyHash !== 'string') {
    console.warn('Skipping agent config: missing name or apiKeyHash', obj)
    return null
  }
  if (!Array.isArray(obj.allowedEndpoints)) {
    console.warn('Skipping agent config: allowedEndpoints is not an array', obj)
    return null
  }
  return {
    name: obj.name,
    apiKeyHash: obj.apiKeyHash,
    allowedEndpoints: obj.allowedEndpoints.filter((e): e is string => typeof e === 'string'),
    crossDomainRecall: obj.crossDomainRecall === true,
  }
}

function loadAgentsFromFile(filePath: string): AgentConfig[] {
  try {
    const resolved = resolve(filePath)
    const raw = readFileSync(resolved, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('AGENTS_FILE must contain a JSON array')
      return []
    }
    return parsed.map(parseAgent).filter((a): a is AgentConfig => a !== null)
  } catch (err) {
    console.error(`Failed to load agents file: ${filePath}`, err)
    return []
  }
}

function loadAgentsFromEnv(raw: string | undefined): AgentConfig[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('AGENTS env var must contain a JSON array')
      return []
    }
    return parsed.map(parseAgent).filter((a): a is AgentConfig => a !== null)
  } catch {
    console.error('Failed to parse AGENTS env var as JSON')
    return []
  }
}

function isListenMode(value: string): value is ListenMode {
  return (LISTEN_MODES as readonly string[]).includes(value)
}

function isAuthMode(value: string): value is AuthMode {
  return (AUTH_MODES as readonly string[]).includes(value)
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
 * Parse the explicit listen interfaces.
 *
 * `LISTEN_HOSTS` (comma separated, trimmed, empty items dropped) wins over the
 * single-address `HOST` alias; giving both is a configuration smell, so warn on
 * stderr and keep the more expressive one. Returning `[]` means "not set".
 */
function parseListenHosts(env: NodeJS.ProcessEnv): string[] {
  const list = (env.LISTEN_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const host = (env.HOST ?? '').trim()

  if (list.length > 0) {
    if (host) {
      console.warn(
        '[config] Both LISTEN_HOSTS and HOST are set; LISTEN_HOSTS wins and HOST is ignored',
      )
    }
    return dedupe(list)
  }
  return host ? [host] : []
}

/**
 * Resolve the listen mode.
 *
 * `TAILSCALE_LISTEN=true` is a shortcut for `LISTEN_MODE=tailscale`. Explicitly
 * combining `LISTEN_MODE=wan` with `TAILSCALE_LISTEN=true` is contradictory and
 * rejected instead of silently picking one.
 */
function parseListenMode(env: NodeJS.ProcessEnv): ListenMode {
  const raw = (env.LISTEN_MODE ?? '').trim()
  const tailscaleFlag = (env.TAILSCALE_LISTEN ?? '').trim().toLowerCase()

  if (tailscaleFlag !== '' && tailscaleFlag !== 'true' && tailscaleFlag !== 'false') {
    throw new Error(
      `Invalid TAILSCALE_LISTEN "${env.TAILSCALE_LISTEN}": expected "true" or "false"`,
    )
  }
  const tailscaleEnabled = tailscaleFlag === 'true'

  if (raw !== '') {
    if (!isListenMode(raw)) {
      throw new Error(
        `Invalid LISTEN_MODE "${env.LISTEN_MODE}": expected one of wan, tailscale, both`,
      )
    }
    if (raw === 'wan' && tailscaleEnabled) {
      throw new Error(
        'Conflicting listen configuration: LISTEN_MODE=wan cannot be combined with ' +
          'TAILSCALE_LISTEN=true; set LISTEN_MODE=tailscale or LISTEN_MODE=both',
      )
    }
    return raw
  }
  return tailscaleEnabled ? 'tailscale' : 'wan'
}

function parseAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  const raw = (env.AUTH_MODE ?? '').trim()
  if (raw === '') return 'shared-key'
  if (!isAuthMode(raw)) {
    throw new Error(`Invalid AUTH_MODE "${env.AUTH_MODE}": expected shared-key or tailscale`)
  }
  return raw
}

function parseV3Upstream(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.V3_UPSTREAM ?? '').trim()
  if (raw === '') return undefined

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid V3_UPSTREAM "${raw}": expected an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid V3_UPSTREAM "${raw}": expected an absolute http(s) URL`)
  }
  // `${v3Upstream}${pathname}` must not produce a double slash.
  return raw.replace(/\/+$/, '')
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = (raw ?? '').trim()
  if (value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${raw}": expected a positive integer`)
  }
  return parsed
}

/**
 * Load and validate the bridge-server configuration.
 *
 * Throws a descriptive error on contradictory/invalid configuration; refusing
 * to start beats silently degrading to a wildcard listener.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const agents = env.AGENTS_FILE
    ? loadAgentsFromFile(env.AGENTS_FILE)
    : loadAgentsFromEnv(env.AGENTS)

  const listenHosts = parseListenHosts(env)
  const listenMode = parseListenMode(env)
  const authMode = parseAuthMode(env)
  const v3Upstream = parseV3Upstream(env)
  const v3ProxyTimeoutMs = parsePositiveInt(
    env.V3_PROXY_TIMEOUT_MS,
    30_000,
    'V3_PROXY_TIMEOUT_MS',
  )

  if (listenMode === 'tailscale' && listenHosts.length > 0) {
    console.warn(
      '[config] LISTEN_MODE=tailscale ignores LISTEN_HOSTS/HOST; ' +
        'use LISTEN_MODE=both to keep both public and Tailscale listeners',
    )
  }

  if (listenMode === 'both' && listenHosts.length === 0) {
    throw new Error(
      'LISTEN_MODE=both requires at least one explicit public interface via ' +
        'LISTEN_HOSTS or HOST; use LISTEN_MODE=wan for wildcard-only listening',
    )
  }

  return {
    port: parseInt(env.PORT || '3000', 10),
    tencentDbUrl: env.TENCENTDB_URL || 'http://localhost:8080',
    agents,
    listenHosts,
    listenMode,
    authMode,
    v3Upstream,
    v3ProxyTimeoutMs,
  }
}
