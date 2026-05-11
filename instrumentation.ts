// Next.js instrumentation hook — runs once on server start (not during build).
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapWorker } = await import('./src/lib/ai-review/worker')
    await bootstrapWorker()
  }
}
