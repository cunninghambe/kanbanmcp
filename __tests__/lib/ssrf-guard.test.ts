import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// ─── Mock node:dns/promises so assertNotPrivateUrl/safeFetch resolution is
//     deterministic. Individual tests set the lookup return value. ───────────
const mockLookup = vi.fn()
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}))

import { isPrivateIP, assertNotPrivateUrl, safeFetch, isOkStatus } from '../../src/lib/ssrf-guard'

describe('isPrivateIP', () => {
  // ── (1) POSITIVE: private / internal addresses must be blocked ────────────
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['10.1.2.3', 'RFC-1918 10/8'],
    ['172.16.0.1', 'RFC-1918 172.16/12'],
    ['172.31.255.255', 'RFC-1918 172.16/12 upper'],
    ['192.168.1.1', 'RFC-1918 192.168/16'],
    ['169.254.1.1', 'IPv4 link-local'],
    ['0.0.0.0', 'IPv4 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['0:0:0:0:0:0:0:1', 'IPv6 loopback expanded'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 ULA fc'],
    ['fd12:3456::1', 'IPv6 ULA fd'],
    ['::', 'IPv6 unspecified'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateIP(ip)).toBe(true)
  })

  // ── IPv4-mapped IPv6 (the HIGH finding) ───────────────────────────────────
  it.each([
    ['::ffff:127.0.0.1', 'mapped loopback dotted'],
    ['::ffff:169.254.169.254', 'mapped metadata dotted'],
    ['::ffff:7f00:1', 'mapped loopback hex (= 127.0.0.1)'],
    ['::ffff:a9fe:a9fe', 'mapped metadata hex (= 169.254.169.254)'],
    ['::FFFF:127.0.0.1', 'mapped loopback uppercase prefix'],
    ['::ffff:0a01:0203', 'mapped 10.1.2.3 hex'],
  ])('blocks IPv4-mapped IPv6 %s (%s)', (ip) => {
    expect(isPrivateIP(ip)).toBe(true)
  })

  // ── (2) NEGATIVE / false-positive boundary: public must NOT be blocked ────
  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['1.1.1.1', 'public IPv4'],
    ['172.15.0.1', 'just below RFC-1918 172.16/12'],
    ['172.32.0.1', 'just above RFC-1918 172.16/12'],
    ['192.167.0.1', 'just below 192.168/16'],
    ['169.253.0.1', 'just below link-local 169.254/16'],
    ['2606:4700::1111', 'public IPv6'],
    ['::ffff:8.8.8.8', 'mapped public IPv4 (must NOT be blocked)'],
    ['::ffff:0808:0808', 'mapped public IPv4 hex (= 8.8.8.8)'],
  ])('allows %s (%s)', (ip) => {
    expect(isPrivateIP(ip)).toBe(false)
  })
})

describe('assertNotPrivateUrl', () => {
  beforeEach(() => {
    mockLookup.mockReset()
  })

  it('rejects an invalid URL', async () => {
    await expect(assertNotPrivateUrl('not-a-url')).rejects.toThrow('Invalid URL')
  })

  it('resolves and allows a fully-public host', async () => {
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    await expect(assertNotPrivateUrl('https://example.com/hook')).resolves.toBeUndefined()
  })

  // resolve-ALL rejection: a host that returns both public and private records
  // must be rejected (the DNS-rebinding / multi-record bypass).
  it('rejects when ANY resolved address is private', async () => {
    mockLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])
    await expect(assertNotPrivateUrl('https://evil.example/hook')).rejects.toThrow(
      'Webhook URL must not target internal addresses'
    )
  })

  it('rejects when resolution returns a mapped-IPv6 private address', async () => {
    mockLookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }])
    await expect(assertNotPrivateUrl('https://rebind.example/hook')).rejects.toThrow(
      'Webhook URL must not target internal addresses'
    )
  })

  it('rejects when DNS resolution fails', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(assertNotPrivateUrl('https://nope.example/hook')).rejects.toThrow(
      'could not be resolved'
    )
  })

  it('rejects when DNS resolution returns no addresses', async () => {
    mockLookup.mockResolvedValue([])
    await expect(assertNotPrivateUrl('https://empty.example/hook')).rejects.toThrow(
      'could not be resolved'
    )
  })
})

describe('safeFetch', () => {
  let server: Server

  beforeEach(() => {
    mockLookup.mockReset()
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects a non-http(s) protocol', async () => {
    await expect(safeFetch('ftp://example.com/x')).rejects.toThrow('http or https')
  })

  it('rejects when the resolved address is private', async () => {
    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(safeFetch('http://internal.example/x')).rejects.toThrow(
      'must not target internal addresses'
    )
  })

  it('rejects when the resolved address is a mapped-IPv6 private form', async () => {
    mockLookup.mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }])
    await expect(safeFetch('http://rebind.example/x')).rejects.toThrow(
      'must not target internal addresses'
    )
  })

  it('rejects when DNS resolution fails', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(safeFetch('http://nope.example/x')).rejects.toThrow('could not be resolved')
  })

  // ── TOCTOU / pinning: validation runs BEFORE any connect ──────────────────
  // A DNS-rebinding attacker would resolve a host to the loopback address at
  // connect time. safeFetch resolves + validates first and pins the result, so
  // when the resolved address is loopback the request must be rejected and the
  // loopback server must NEVER receive a byte.
  it('rejects a loopback-resolving host before contacting the server', async () => {
    let contacted = false
    server = createServer((req, res) => {
      contacted = true
      res.statusCode = 200
      res.end('should-not-be-reached')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo

    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(
      safeFetch(`http://my-host.example:${port}/hook`, { method: 'POST', body: 'hello' })
    ).rejects.toThrow('must not target internal addresses')

    expect(contacted).toBe(false)
  })
})

describe('isOkStatus (redirect / ok mapping)', () => {
  // safeFetch does not follow redirects: only 2xx is ok. This is the unit-level
  // guarantee that a 302 to an internal address is reported as a non-ok result.
  it.each([
    [200, true],
    [201, true],
    [204, true],
    [299, true],
  ])('treats 2xx (%i) as ok', (status, expected) => {
    expect(isOkStatus(status)).toBe(expected)
  })

  it.each([
    [300, false],
    [301, false],
    [302, false], // redirect to e.g. http://169.254.169.254/ must be ok=false
    [307, false],
    [400, false],
    [404, false],
    [500, false],
  ])('treats non-2xx (%i) as NOT ok (redirects not followed)', (status, expected) => {
    expect(isOkStatus(status)).toBe(expected)
  })
})
