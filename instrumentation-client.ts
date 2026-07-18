// Next.js client instrumentation hook — runs once in the browser before the
// app hydrates. https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
//
// uh-oh crash reporting (self-hosted). NEXT_PUBLIC_UH_OH_DSN unset => the
// vendored client's init() is a silent no-op (see src/lib/uh-oh-client.ts).
import pkg from './package.json'
import { init } from '@/lib/uh-oh-client'

init({
  // Privacy-first usage analytics (cookie-less; no client IDs). v0.6.
  analytics: { auto: true },
  dsn: process.env.NEXT_PUBLIC_UH_OH_DSN,
  release: `${pkg.version}+0`,
  environment: process.env.NODE_ENV,
})
