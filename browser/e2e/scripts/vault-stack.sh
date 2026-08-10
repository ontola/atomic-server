#!/usr/bin/env bash
#
# The two extra services a Cloud Vault e2e needs, on top of the ones
# `e2e-server.sh` and the vite dev server already provide.
#
#   MinIO           object storage the browser PUTs sealed packs to
#   atomic-saas     the control plane that brokers presigned URLs
#
# The vault path is the only part of the app that talks to a second backend, so
# it is the only suite that needs this. Everything else stays untouched.
#
#   ./scripts/vault-stack.sh          # start both, wait until healthy
#   ./scripts/vault-stack.sh --stop   # tear both down
#
# Ports are deliberately away from the defaults: 9100 for MinIO because 9000 is
# a popular default and another project's MinIO answering there produces
# `InvalidAccessKeyId`, which reads as a signing bug rather than "wrong server".
# STATUS: MinIO half works and fails loudly on a port clash, as intended. The
# control-plane launch does NOT yet stay up — the backgrounded `cargo run`
# leaves an empty log and no process, which points at process-group handling
# rather than at the control plane itself (running the same env by hand works).
# Unfinished on purpose: see planning/VAULT_LOCAL_E2E.md. Do not treat a green
# run of this script as a working stack until that is fixed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SAAS_DIR="${ATOMIC_SAAS_DIR:-$REPO_ROOT/../atomic-saas}"
MINIO_PORT="${ATOMIC_VAULT_TEST_MINIO_PORT:-9100}"
SAAS_PORT="${ATOMIC_SAAS_E2E_PORT:-3031}"
BUCKET=atomic-vault-e2e
MINIO_DATA="${ATOMIC_VAULT_E2E_MINIO_DATA:-/tmp/atomic-vault-e2e}"
SAAS_DB="${ATOMIC_SAAS_E2E_DB:-/tmp/atomic-vault-e2e-saas.redb}"
SAAS_LOG="${ATOMIC_SAAS_E2E_LOG:-/tmp/atomic-vault-e2e-saas.log}"
PID_FILE=/tmp/atomic-vault-e2e-saas.pid

stop() {
  docker rm -f atomic-vault-e2e-minio >/dev/null 2>&1 || true

  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi

  echo "vault stack stopped"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop
  exit 0
fi

stop

# ── MinIO ──────────────────────────────────────────────────────────────────
# The bucket is just a directory: MinIO's filesystem backend exposes each
# top-level directory under its data path as one, so no mc/aws CLI is needed.
rm -rf "$MINIO_DATA"
mkdir -p "$MINIO_DATA/$BUCKET"

docker run -d --name atomic-vault-e2e-minio \
  -p "$MINIO_PORT:9000" \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  -e MINIO_DOMAIN=localhost \
  -v "$MINIO_DATA:/data" \
  minio/minio server /data >/dev/null

for _ in $(seq 1 30); do
  curl -sf "http://localhost:$MINIO_PORT/minio/health/live" >/dev/null && break
  sleep 1
done

# `docker run` fails *silently* on a port clash when its output is redirected,
# leaving a container in `Created` while the health check above passes against
# whatever already owns the port. Check the container, not just the health.
if [[ -z "$(docker ps --filter name=atomic-vault-e2e-minio --format '{{.ID}}')" ]]; then
  echo "MinIO did not start — is something already on port $MINIO_PORT?" >&2
  docker logs atomic-vault-e2e-minio 2>&1 | tail -20 >&2
  exit 1
fi

echo "MinIO up on $MINIO_PORT (bucket $BUCKET)"

# ── Control plane ──────────────────────────────────────────────────────────
if [[ ! -d "$SAAS_DIR" ]]; then
  echo "atomic-saas checkout not found at $SAAS_DIR — set ATOMIC_SAAS_DIR." >&2
  exit 1
fi

rm -f "$SAAS_DB"

# Virtual-hosted addressing puts the bucket in the host name. macOS resolves
# *.localhost natively; Linux does not, so name it once.
if ! grep -q "$BUCKET.localhost" /etc/hosts 2>/dev/null; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "127.0.0.1 $BUCKET.localhost" | sudo tee -a /etc/hosts >/dev/null
  fi
fi

# `nohup` and no subshell: a backgrounded job inside `( ... )` dies with the
# subshell, which showed up as an empty log and no process rather than an
# error. This keeps the control plane alive after the script returns.
(
  cd "$SAAS_DIR" || exit 1
  # Dev magic links so the suite can sign in without a mail server, and a
  # throwaway DB so a run never touches a real one.
  #
  # The local-process node provider is chosen only to avoid HCLOUD_TOKEN: the
  # Hetzner provider demands one at construction, and the vault needs no
  # managed nodes at all — it brokers presigned URLs, nothing more. No node is
  # ever spawned here.
  nohup env \
    ATOMIC_SAAS_DEV_MAGIC_LINKS=true \
    POSTMARK_TOKEN=mock \
    POSTMARK_FROM=e2e@localhost \
    ATOMIC_SAAS_SKIP_NODE_HEALTH_CHECKS=true \
    ATOMIC_SAAS_NODE_PROVIDER=local-process \
    DB_PATH="$SAAS_DB" \
    PORT="$SAAS_PORT" \
    SAAS_URL="http://localhost:$SAAS_PORT" \
    ATOMIC_VAULT_S3_BUCKET="$BUCKET" \
    ATOMIC_VAULT_S3_REGION=us-east-1 \
    ATOMIC_VAULT_S3_ENDPOINT="http://$BUCKET.localhost:$MINIO_PORT" \
    ATOMIC_VAULT_S3_VIRTUAL_HOSTED=1 \
    ATOMIC_VAULT_S3_ALLOW_HTTP=1 \
    ATOMIC_VAULT_PSEUDONYM_SALT=e2e-salt \
    AWS_ACCESS_KEY_ID=minioadmin \
    AWS_SECRET_ACCESS_KEY=minioadmin \
    cargo run --quiet --bin atomic-saas >"$SAAS_LOG" 2>&1 &
  echo $! >"$PID_FILE"
) 
# First run compiles atomic-saas, which takes minutes rather than seconds.
for _ in $(seq 1 300); do
  curl -sf "http://localhost:$SAAS_PORT/api/me" >/dev/null 2>&1 && break
  # /api/me answers 401 without a session, which still means it is listening.
  curl -s -o /dev/null "http://localhost:$SAAS_PORT/api/me" && break
  sleep 1
done

if ! curl -s -o /dev/null "http://localhost:$SAAS_PORT/api/me"; then
  echo "control plane did not come up — see $SAAS_LOG" >&2
  tail -20 "$SAAS_LOG" >&2
  exit 1
fi

echo "control plane up on $SAAS_PORT (log: $SAAS_LOG)"
echo
echo "Point the SPA at it with:"
echo "  VITE_MANAGED_PORTAL_URL=http://localhost:$SAAS_PORT"
