#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> Resetting dev DB..."
rm -f kanban.db
echo "==> Applying schema..."
npm run db:push
echo "==> Seeding..."
npm run db:seed
echo "==> Running tests..."
npm test
echo "==> Smoke passed."
