import { execSync } from 'child_process'
import path from 'path'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const ENV_TEST_PATH = path.resolve(__dirname, '../.env.local')

export default async function globalTeardown() {
  execSync(`rm -f "${E2E_DB}" "${E2E_DB}-wal" "${E2E_DB}-shm" "${ENV_TEST_PATH}"`, {
    stdio: 'inherit',
  })
}
