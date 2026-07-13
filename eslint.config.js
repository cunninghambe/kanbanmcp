const nextConfig = require('eslint-config-next/core-web-vitals')

module.exports = [
  // design mockups, not built or imported
  { ignores: ['docs/design/**'] },
  ...nextConfig,
]
