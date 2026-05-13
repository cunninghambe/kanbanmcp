import { execSync } from 'child_process'
import path from 'path'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')

export default async function globalTeardown() {
  execSync(`rm -f "${E2E_DB}"`, { stdio: 'inherit' })
}
