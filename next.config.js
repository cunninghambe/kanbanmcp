/** @type {import('next').NextConfig} */
// AUTOGENY_TS_TOLERANCE
const isProd = process.env.NODE_ENV === 'production'

const path = require('path')

// uh-oh crash reporting: only emit source maps (browser + server) when the
// deploy-time upload credentials are present in the build environment, so a
// routine build/deploy that isn't touching crash reporting never produces
// .map files in the first place - nothing to accidentally serve publicly.
// scripts/uh-oh-postbuild.mjs (wired as `postbuild` in package.json) uploads
// and deletes the browser maps this generates, plus does an unconditional
// safety sweep of .next/static for any that survive a partial upload
// failure. See README.md's "Deploy" section for the full pipeline.
const uhOhSourceMapsEnabled = Boolean(
  process.env.UH_OH_SERVER_URL && process.env.UH_OH_SYMBOL_TOKEN && process.env.UH_OH_PROJECT
)

const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  productionBrowserSourceMaps: uhOhSourceMapsEnabled,
  experimental: {
    serverSourceMaps: uhOhSourceMapsEnabled,
  },
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
