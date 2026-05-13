import { defineConfig } from 'vitest/config'
import path from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: [],
    testTimeout: 10000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
    env: {
      SESSION_SECRET: 'test-session-secret-for-vitest-only',
      DATABASE_URL: 'file:./kanban-test.db',
      NODE_ENV: 'test',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
