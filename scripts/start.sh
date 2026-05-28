#!/usr/bin/env bash
# pm2 entrypoint for the kanban Next.js app.
# Syncs the SQLite schema to the current Prisma schema BEFORE serving, so a
# rebuilt app (new column/table expectations) never serves against a stale DB.
# This is the guard for the "PrismaClientKnownRequestError: column does not
# exist" class of 500s that happens when code ships ahead of the DB.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3002}"
DB_FILE="prisma/kanban.db"

# Roll a pre-sync backup so an unexpected destructive diff is always recoverable.
# Keep the 10 most recent; prune the rest to avoid unbounded growth in a crash loop.
if [ -f "$DB_FILE" ]; then
  cp -a "$DB_FILE" "${DB_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  ls -1t "${DB_FILE}.bak."* 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# Additive schema changes apply cleanly. --accept-data-loss is required because
# Prisma flags SQLite table rebuilds (used for adding columns) as destructive
# even when data is preserved via INSERT...SELECT. The backup above is the net
# in the rare event a genuinely destructive diff is ever introduced.
npx prisma db push --accept-data-loss --skip-generate

exec node_modules/.bin/next start -p "$PORT"
