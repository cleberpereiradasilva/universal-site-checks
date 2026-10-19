#!/usr/bin/env bash
# One-shot setup after `npx wrangler login`:
# creates the D1 database, writes its id into wrangler.toml, applies migrations,
# uploads secrets from .dev.vars and deploys the Worker.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="universal-monitor"

if grep -q 'REPLACE_AFTER_D1_CREATE' wrangler.toml; then
  echo "==> Creating D1 database '$DB_NAME'"
  OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  [ -n "$ID" ] || { echo "Could not parse database id from:"; echo "$OUT"; exit 1; }
  sed -i "s/REPLACE_AFTER_D1_CREATE/$ID/" wrangler.toml
  echo "    database_id = $ID"
fi

echo "==> Applying migrations (remote)"
npx wrangler d1 migrations apply "$DB_NAME" --remote

echo "==> Uploading secrets from .dev.vars"
[ -f .dev.vars ] || { echo ".dev.vars not found"; exit 1; }
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  if [ -z "$value" ]; then echo "    skip $key (empty)"; continue; fi
  printf '%s' "$value" | npx wrangler secret put "$key" >/dev/null
  echo "    set  $key"
done < .dev.vars

echo "==> Deploying"
npx wrangler deploy
