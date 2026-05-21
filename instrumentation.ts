// Next.js instrumentation hook — runs once on server start (not during build).
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapWorker: bootstrapAiReview } = await import('./src/lib/ai-review/worker')
    try {
      await bootstrapAiReview()
    } catch (err) {
      // Gracefully handle DB unavailability at startup (e.g. during e2e test runs
      // before the database is fully initialised). Pending reviews will not be
      // re-enqueued — they will be picked up on the next server restart.
      console.warn('[instrumentation] ai-review bootstrapWorker failed, skipping re-queue:', err)
    }

    const { bootstrapWorker: bootstrapCardExecution } = await import('./src/lib/card-execution/worker')
    try {
      await bootstrapCardExecution()
    } catch (err) {
      console.warn('[instrumentation] card-execution bootstrapWorker failed, skipping re-queue:', err)
    }
  }
}
