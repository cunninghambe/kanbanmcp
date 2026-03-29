import { lookup } from 'node:dns/promises'

/**
 * Returns true if the given IPv4 or IPv6 address is a private/internal address
 * that should never be the target of outbound server requests.
 * Covers: loopback, link-local, RFC-1918, and IPv6 equivalents.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4
  const parts = ip.split('.')
  if (parts.length === 4) {
    const nums = parts.map(Number)
    if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      const [a, b] = nums
      if (a === 127) return true                          // loopback 127.0.0.0/8
      if (a === 10) return true                           // RFC-1918 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true   // RFC-1918 172.16.0.0/12
      if (a === 192 && b === 168) return true             // RFC-1918 192.168.0.0/16
      if (a === 169 && b === 254) return true             // link-local 169.254.0.0/16
      if (a === 0) return true                            // 0.0.0.0/8
    }
  }

  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true
  // IPv6 link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true
  // IPv6 unique local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true

  return false
}

/**
 * Resolves the hostname from a URL and throws if it maps to a private/internal
 * IP address, preventing SSRF attacks via user-supplied webhook URLs.
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

  let address: string
  try {
    const result = await lookup(hostname)
    address = result.address
  } catch {
    // DNS resolution failure — reject to be safe
    throw new Error('Webhook URL hostname could not be resolved')
  }

  if (isPrivateIP(address)) {
    throw new Error('Webhook URL must not target internal addresses')
  }
}
