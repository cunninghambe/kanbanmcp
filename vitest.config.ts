import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: [],
    testTimeout: 10000,
    env: {
      SESSION_SECRET: 'test-session-secret-for-vitest-only',
      DATABASE_URL: 'file:./kanban-test.db',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
