/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from 'vitest'
import { isIpv4, resolveTailscaleIpv4 } from '../tailscale.js'

interface TestIface {
  address: string
  family: string | number
  internal: boolean
}

function iface(
  address: string,
  family: string | number = 'IPv4',
  internal = false,
): TestIface {
  return { address, family, internal }
}

const cliOk = (stdout: string) => async () => ({ stdout })
const cliFail = async () => {
  throw new Error('spawn tailscale ENOENT')
}

describe('isIpv4', () => {
  it('accepts valid dotted-quad addresses', () => {
    for (const value of ['100.87.60.42', '127.0.0.1', '0.0.0.0', '255.255.255.255']) {
      expect(isIpv4(value)).toBe(true)
    }
  })

  it('rejects malformed addresses', () => {
    for (const value of [
      '999.1.1.1',
      '100.1.1',
      '100.1.1.1.1',
      '010.1.1.1',
      'abc',
      '100.1.1.1 ',
      '',
    ]) {
      expect(isIpv4(value)).toBe(false)
    }
  })
})

describe('resolveTailscaleIpv4', () => {
  it('prefers `tailscale ip -4` output (first non-empty line, trimmed)', async () => {
    const execFile = vi.fn(cliOk('\n 100.87.60.42 \nfd7a::1\n'))
    const ip = await resolveTailscaleIpv4({
      execFile,
      networkInterfaces: () => ({ tailscale0: [iface('100.99.99.99')] }),
      env: { TAILSCALE_IP: '100.11.11.11' },
    })
    expect(ip).toBe('100.87.60.42')
    expect(execFile).toHaveBeenCalledWith('tailscale', ['ip', '-4'], { timeout: 2000 })
  })

  it('falls back to the tailscale0 interface when the CLI is unavailable', async () => {
    const ip = await resolveTailscaleIpv4({
      execFile: cliFail,
      networkInterfaces: () => ({
        tailscale0: [iface('fe80::1', 'IPv6'), iface('100.87.60.42')],
        eth0: [iface('192.168.1.10')],
      }),
      env: {},
    })
    expect(ip).toBe('100.87.60.42')
  })

  it('accepts numeric family 4 and ignores internal/invalid interface entries', async () => {
    const ip = await resolveTailscaleIpv4({
      execFile: cliFail,
      networkInterfaces: () => ({
        tailscale0: [iface('100.1.1.1', 4, true), iface('not-an-ip', 4), iface('100.2.2.2', 4)],
      }),
      env: {},
    })
    expect(ip).toBe('100.2.2.2')
  })

  it('falls back to TAILSCALE_IP when CLI and interface both fail', async () => {
    const ip = await resolveTailscaleIpv4({
      execFile: cliFail,
      networkInterfaces: () => ({}),
      env: { TAILSCALE_IP: ' 100.64.0.7 ' },
    })
    expect(ip).toBe('100.64.0.7')
  })

  it('ignores invalid CLI output and keeps falling back', async () => {
    const ip = await resolveTailscaleIpv4({
      execFile: cliOk('not-an-ip\n'),
      networkInterfaces: () => ({ tailscale0: [iface('100.87.60.42')] }),
      env: {},
    })
    expect(ip).toBe('100.87.60.42')
  })

  it('throws a clear error when every source fails', async () => {
    const promise = resolveTailscaleIpv4({
      execFile: cliFail,
      networkInterfaces: () => ({ tailscale0: [] }),
      env: {},
    })
    await expect(promise).rejects.toThrow(/Unable to resolve the Tailscale IPv4/)
    await expect(
      resolveTailscaleIpv4({
        execFile: cliFail,
        networkInterfaces: () => ({}),
        env: {},
      }),
    ).rejects.toThrow(/tailscale ip -4[\s\S]*tailscale0[\s\S]*TAILSCALE_IP/)
  })

  it('rejects an invalid TAILSCALE_IP instead of accepting it', async () => {
    await expect(
      resolveTailscaleIpv4({
        execFile: cliFail,
        networkInterfaces: () => ({}),
        env: { TAILSCALE_IP: '100.1.1' },
      }),
    ).rejects.toThrow(/TAILSCALE_IP="100\.1\.1" is not a valid IPv4 address/)
  })
})
