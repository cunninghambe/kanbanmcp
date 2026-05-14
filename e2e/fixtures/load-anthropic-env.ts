/**
 * Loads Anthropic credentials from well-known dev-box .env files into process.env
 * before Playwright reads its config. Harmless in CI where the vars are already set.
 *
 * Priority order:
 *   1. Already set in environment (CI / explicit export) — untouched
 *   2. /root/.hermes/.env            (ANTHROPIC_API_KEY)
 *   3. /root/claude-discord-bridge/.env  (CLAUDE_CODE_OAUTH_TOKEN)
 */
import { config as dotenvConfig } from 'dotenv'

const HERMES_ENV = '/root/.hermes/.env'
const BRIDGE_ENV = '/root/claude-discord-bridge/.env'

dotenvConfig({ path: HERMES_ENV, override: false })
dotenvConfig({ path: BRIDGE_ENV, override: false })
