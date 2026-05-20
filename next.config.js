/** @type {import('next').NextConfig} */
// AUTOGENY_TS_TOLERANCE
const isProd = process.env.NODE_ENV === 'production'

const path = require('path')

const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  turbopack: {
    root: path.resolve(__dirname),
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/login',
        permanent: false,
      },
    ]
  },
  async headers() {
    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ]
    if (isProd) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      })
    }
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}

module.exports = nextConfig
