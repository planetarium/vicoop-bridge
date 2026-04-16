#!/usr/bin/env bash
set -euo pipefail

APP_NAME="vicoop-bridge-relay"
DB_APP="${APP_NAME}-db"
PRIMARY_REGION="nrt"

WITH_DB=0
for arg in "$@"; do
  case "$arg" in
    --with-db) WITH_DB=1 ;;
  esac
done

if [[ "$WITH_DB" -eq 1 ]]; then
  echo "==> Creating Fly Postgres: $DB_APP"
  if ! fly postgres list 2>/dev/null | grep -q "$DB_APP"; then
    fly postgres create \
      -n "$DB_APP" \
      -r "$PRIMARY_REGION" \
      --initial-cluster-size 1 \
      --vm-size shared-cpu-2x \
      --volume-size 10
  else
    echo "Postgres app $DB_APP already exists, skipping create."
  fi

  echo "==> Attaching Postgres to $APP_NAME"
  SECRETS_OUTPUT=$(fly secrets list -a "$APP_NAME" 2>/dev/null || true)
  if ! echo "$SECRETS_OUTPUT" | grep -q "^DATABASE_URL"; then
    fly postgres attach "$DB_APP" \
      -a "$APP_NAME" \
      --database-name relay \
      --database-user app_postgraphile \
      --variable-name DATABASE_URL \
      --superuser=false \
      --yes

    fly postgres attach "$DB_APP" \
      -a "$APP_NAME" \
      --database-name relay \
      --database-user db_setup \
      --variable-name DB_SETUP_URL \
      --superuser \
      --yes
  else
    echo "Already attached, skipping."
  fi
fi

echo "==> Deploying $APP_NAME"
fly deploy -a "$APP_NAME" --remote-only
