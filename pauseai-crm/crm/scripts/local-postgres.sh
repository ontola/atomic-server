#!/usr/bin/env bash
# Start a throwaway PostgreSQL 16 cluster for local development without Docker.
# Data lives in ./.local-postgres (git-ignored). Requires the postgres binaries
# (apt install postgresql-16, brew install postgresql@16).
#
#   pnpm db:local          start (or restart) the cluster on port 54329
#   pnpm db:local stop     stop it
set -euo pipefail
PORT="${PG_PORT:-54329}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.local-postgres"
BIN="$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl /opt/homebrew/opt/postgresql@16/bin/pg_ctl 2>/dev/null | head -1)")"

if [ "${1:-start}" = "stop" ]; then
  "$BIN/pg_ctl" -D "$DIR/data" stop -m fast
  exit 0
fi

if [ ! -f "$DIR/data/PG_VERSION" ]; then
  mkdir -p "$DIR"
  "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 >/dev/null
fi
"$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" restart >/dev/null
sleep 1
"$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='pauseai_crm'" | grep -q 1 \
  || "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -c "create database pauseai_crm" >/dev/null
echo "PostgreSQL ready: postgres://postgres@127.0.0.1:$PORT/pauseai_crm"
