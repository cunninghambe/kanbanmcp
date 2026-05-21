import { vi } from 'vitest'

// Wrap node:fs/promises in a configurable proxy so vi.spyOn works on individual functions.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})
