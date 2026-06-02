import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress, LookupOptions } from 'node:dns'

/**
 * Returns true if the given IPv4 dotted-quad string is a private/internal
 * address. Expects an already-validated 4-octet string.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false
  const [a, b] = nums
  if (a === 127) return true // loopback 127.0.0.0/8
  if (a === 10) return true // RFC-1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // RFC-1918 172.16.0.0/12
  if (a === 192 && b === 168) return true // RFC-1918 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
  if (a === 0) return true // 0.0.0.0/8 (incl. unspecified 0.0.0.0)
  return false
}

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Handles both the dotted form (::ffff:169.254.169.254) and the hex form
 * (::ffff:7f00:1 → 127.0.0.1). Returns null if no IPv4 can be extracted.
 */
function extractMappedIPv4(ip: string): string | null {
  // Dotted form: ::ffff:a.b.c.d
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dotted) return dotted[1]

  // Hex form: ::ffff:hhhh:hhhh
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    if (Number.isNaN(high) || Number.isNaN(low)) return null
    const a = (high >> 8) & 0xff
    const b = high & 0xff
    const c = (low >> 8) & 0xff
    const d = low & 0xff
    return `${a}.${b}.${c}.${d}`
  }

  return null
}

/**
 * Returns true if the given IPv4 or IPv6 address is a private/internal address
 * that should never be the target of outbound server requests.
 * Covers: loopback, link-local, RFC-1918, unspecified, IPv6 equivalents, and
 * IPv4-mapped IPv6 forms (which dual-stack DNS resolution can produce).
 */
export function isPrivateIP(ip: string): boolean {
  const normalized = ip.trim().toLowerCase()

  // Unspecified addresses are never a valid outbound target.
  if (normalized === '::' || normalized === '0.0.0.0') return true

  const kind = isIP(normalized)

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1). DNS lookups on a
  // dual-stack host can return these forms; unwrap and apply IPv4 checks.
  if (normalized.startsWith('::ffff:')) {
    const mapped = extractMappedIPv4(normalized)
    if (mapped !== null) return isPrivateIPv4(mapped)
  }

  if (kind === 4) {
    return isPrivateIPv4(normalized)
  }

  if (kind === 6) {
    // Loopback ::1
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
    // Link-local fe80::/10 (fe8x, fe9x, feax, febx)
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true
    // Unique local fc00::/7 (fcxx, fdxx)
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true
    return false
  }

  // Not a recognizable IP literal — fall back to the IPv4 check in case it is a
  // bare dotted-quad that isIP rejected for some reason.
  return isPrivateIPv4(normalized)
}

/**
 * Resolves the hostname from a URL and throws if ANY resolved address maps to a
 * private/internal IP, preventing SSRF attacks via user-supplied webhook URLs.
 *
 * Resolves every address (lookup all) rather than a single result so that a
 * host with both a public and a private record cannot slip through.
 *
 * @throws Error if the URL is invalid or resolves to a private address.
 */
export async function assertNotPrivateUrl(url: string): Promise<void> {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error('Invalid URL')
  }

  let addresses: LookupAddress[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    // DNS resolution failure — reject to be safe
    throw new Error('Webhook URL hostname could not be resolved')
  }

  if (addresses.length === 0) {
    throw new Error('Webhook URL hostname could not be resolved')
  }

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error('Webhook URL must not target internal addresses')
    }
  }
}

export type SafeFetchOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export type SafeFetchResult = {
  ok: boolean
  status: number
  statusText: string
  bodyText?: string
}

/**
 * Maps an HTTP status code to the `ok` flag. Only 2xx is ok; redirects (3xx)
 * are deliberately treated as NOT ok because safeFetch does not follow them —
 * a public URL must not be able to 302 to an internal address.
 */
export function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300
}

/**
 * Performs an outbound HTTP(S) request that is hardened against SSRF:
 *
 *  1. Resolves ALL addresses for the host and rejects if any is private
 *     (normalizing IPv4-mapped IPv6 forms first).
 *  2. PINS the connection to a validated address via the `lookup` option, so
 *     the kernel/agent cannot re-resolve to a different (private) IP between
 *     the check and the connect (defeats DNS-rebinding TOCTOU). The original
 *     hostname is preserved for the Host header and TLS SNI.
 *  3. Does NOT follow redirects — any 3xx is returned as a non-ok response, so
 *     a public URL cannot 302 to an internal address.
 *
 * Dependency-free: uses node:http / node:https request().
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = opts

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https')
  }

  const hostname = parsed.hostname

  // Resolve all addresses and validate each one.
  let addresses: LookupAddress[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new Error('Webhook URL hostname could not be resolved')
  }

  if (addresses.length === 0) {
    throw new Error('Webhook URL hostname could not be resolved')
  }

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error('Webhook URL must not target internal addresses')
    }
  }

  // Pin to the first validated address. The `lookup` option below forces the
  // connection to use exactly this IP, so no re-resolution can occur.
  const pinned = addresses[0]

  const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80
  const port = parsed.port ? Number(parsed.port) : defaultPort

  return new Promise<SafeFetchResult>((resolve, reject) => {
    let settled = false

    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname,
        port,
        method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        // Pin the resolved IP: ignore the passed hostname and hand back ONLY
        // the validated address. Preserves Host header + TLS SNI = hostname.
        lookup: (
          _host: string,
          _options: LookupOptions,
          cb: (err: NodeJS.ErrnoException | null, addr: string, family: number) => void
        ) => {
          cb(null, pinned.address, pinned.family)
        },
        // For TLS, servername (SNI) defaults to the request hostname, which is
        // what we want — only the connect IP is pinned.
        servername: parsed.protocol === 'https:' ? hostname : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (settled) return
          settled = true
          const status = res.statusCode ?? 0
          resolve({
            // Do NOT follow redirects: any 3xx is a completed, non-ok response.
            ok: isOkStatus(status),
            status,
            statusText: res.statusMessage ?? '',
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )

    req.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('Request timed out'))
    })

    req.on('error', (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    })

    if (body !== undefined) {
      req.write(body)
    }
    req.end()
  })
}
