// Next.js instrumentation hook — runs once on server start (not during build).
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
import pkg from './package.json'
import * as uhOh from '@/lib/uh-oh-client'

// uh-oh crash reporting (self-hosted). Node-side init only — the browser
// counterpart lives in instrumentation-client.ts. UH_OH_DSN unset => the
// vendored client's init() is a silent no-op (see src/lib/uh-oh-client.ts).
const RELEASE = `${pkg.version}+0`

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    uhOh.init({
      dsn: process.env.UH_OH_DSN,
      release: RELEASE,
      environment: process.env.NODE_ENV,
    })

    const { bootstrapWorker: bootstrapAiReview } = await import('./src/lib/ai-review/worker')
    try {
      await bootstrapAiReview()
    } catch (err) {
      // Gracefully handle DB unavailability at startup (e.g. during e2e test runs
      // before the database is fully initialised). Pending reviews will not be
      // re-enqueued — they will be picked up on the next server restart.
      console.warn('[instrumentation] ai-review bootstrapWorker failed, skipping re-queue:', err)
      uhOh.captureException(err, { mechanism: 'js-global' })
    }

    const { bootstrapWorker: bootstrapCardExecution } = await import('./src/lib/card-execution/worker')
    try {
      await bootstrapCardExecution()
    } catch (err) {
      console.warn('[instrumentation] card-execution bootstrapWorker failed, skipping re-queue:', err)
      uhOh.captureException(err, { mechanism: 'js-global' })
    }

    const { bootstrapWorker: bootstrapHostHud } = await import('./src/lib/host-hud/worker')
    try {
      await bootstrapHostHud()
    } catch (err) {
      console.warn('[instrumentation] host-hud bootstrapWorker failed, skipping re-queue:', err)
      uhOh.captureException(err, { mechanism: 'js-global' })
    }
  }
}

// Next 15+ server-error hook: fires for uncaught errors during render/route/
// action handling in the nodejs (and edge) runtime. In the edge runtime this
// is a no-op (uh-oh is only init'd above under NEXT_RUNTIME === 'nodejs'; the
// client's captureException() safely no-ops when no client was init'd).
type RequestErrorContext = {
  routerKind: 'Pages Router' | 'App Router'
  routePath: string
  routeType: 'render' | 'route' | 'action' | 'proxy'
  renderSource?: 'react-server-components' | 'react-server-components-payload' | 'server-rendering'
  revalidateReason: 'on-demand' | 'stale' | undefined
}
type RequestErrorRequest = Readonly<{
  path: string
  method: string
  headers: Record<string, string | string[] | undefined>
}>

export async function onRequestError(
  error: unknown,
  _request: RequestErrorRequest,
  _context: Readonly<RequestErrorContext>
): Promise<void> {
  uhOh.captureException(error, { mechanism: 'js-global' })
}
