import { execFile as execFileCallback } from 'node:child_process'
import { networkInterfaces as osNetworkInterfaces } from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/** Timeout for `tailscale ip -4`; the CLI is expected to answer immediately. */
export const TAILSCALE_CLI_TIMEOUT_MS = 2000

/** Name of the Linux Tailscale network interface. */
export const TAILSCALE_INTERFACE_NAME = 'tailscale0'

export interface TailscaleExecResult {
  stdout: string
}

export interface TailscaleResolverDeps {
  /** Injectable for tests; defaults to a promisified `child_process.execFile`. */
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<TailscaleExecResult>
  /** Injectable for tests; defaults to `os.networkInterfaces()`. */
  networkInterfaces?: () => NodeJS.Dict<{ address: string; family: string | number; internal: boolean }[]>
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Strict dotted-quad IPv4 validation (rejects `999.1.1.1`, shorthand forms and
 * leading/trailing whitespace — callers trim first).
 */
export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(part)) return false
  }
  return true
}

const defaultExecFile: NonNullable<TailscaleResolverDeps['execFile']> = async (
  file,
  args,
  options,
) => {
  const result = await execFile(file, args, { ...options, encoding: 'utf8' })
  return { stdout: String(result.stdout) }
}

async function fromCli(deps: TailscaleResolverDeps): Promise<string | null> {
  const run = deps.execFile ?? defaultExecFile
  try {
    const { stdout } = await run('tailscale', ['ip', '-4'], {
      timeout: TAILSCALE_CLI_TIMEOUT_MS,
    })
    const candidate = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (candidate !== undefined && isIpv4(candidate)) return candidate
    return null
  } catch {
    return null
  }
}

function fromInterface(deps: TailscaleResolverDeps): string | null {
  const readInterfaces = deps.networkInterfaces ?? osNetworkInterfaces
  let interfaces: NodeJS.Dict<{ address: string; family: string | number; internal: boolean }[]>
  try {
    interfaces = readInterfaces()
  } catch {
    return null
  }
  const candidates = interfaces[TAILSCALE_INTERFACE_NAME] ?? []
  for (const info of candidates) {
    const isIpv4Family = info.family === 'IPv4' || info.family === 4
    if (!isIpv4Family || info.internal) continue
    // Tailscale addresses are CGNAT 100.64.0.0/10; accept any valid IPv4 to
    // avoid guessing, but never return loopback/link-local interfaces.
    if (isIpv4(info.address)) return info.address
  }
  return null
}

/**
 * Resolve the IPv4 address Tailscale assigned to this host.
 *
 * Resolution order (each step is a fallback, never a silent wildcard listen):
 *   1. `tailscale ip -4` (2s timeout) — authoritative, works even if the
 *      interface name differs from `tailscale0`;
 *   2. the IPv4 of interface `tailscale0` — works when the CLI is not on PATH
 *      (e.g. systemd service user);
 *   3. `TAILSCALE_IP` environment variable — explicit operator override.
 *
 * No IP is hardcoded. Throws a descriptive error listing every failed step.
 */
export async function resolveTailscaleIpv4(
  deps: TailscaleResolverDeps = {},
): Promise<string> {
  const reasons: string[] = []

  const cliIp = await fromCli(deps)
  if (cliIp) return cliIp
  reasons.push('`tailscale ip -4` failed or returned no valid IPv4 address')

  const interfaceIp = fromInterface(deps)
  if (interfaceIp) return interfaceIp
  reasons.push(
    `network interface ${TAILSCALE_INTERFACE_NAME} has no non-internal IPv4 address`,
  )

  const envRaw = (deps.env ?? process.env).TAILSCALE_IP?.trim()
  if (envRaw) {
    if (isIpv4(envRaw)) return envRaw
    reasons.push(`TAILSCALE_IP="${envRaw}" is not a valid IPv4 address`)
  } else {
    reasons.push('TAILSCALE_IP is not set')
  }

  throw new Error(
    `Unable to resolve the Tailscale IPv4 address:\n- ${reasons.join('\n- ')}\n` +
      'Fix the Tailscale setup or set TAILSCALE_IP explicitly.',
  )
}
