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
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SAAS_DIR="${ATOMIC_SAAS_DIR:-$REPO_ROOT/../atomic-saas}"
MINIO_PORT="${ATOMIC_VAULT_TEST_MINIO_PORT:-9100}"
# 3030, because that is hardcoded in atomic-saas's `main.rs` — there is no port
# env var. Inventing one here meant the control plane started fine on 3030
# while this script polled 3031 and reported it dead.
SAAS_PORT=3030
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
  # `nohup` alone, no `setsid`: macOS has no setsid, and nohup plus the PID
  # check below is enough to both detach and notice a startup crash.
  nohup env \
    RUST_LOG=info,atomic_saas=debug \
    ATOMIC_SAAS_DEV_MAGIC_LINKS=true \
    POSTMARK_TOKEN=mock \
    POSTMARK_FROM=e2e@localhost \
    ATOMIC_SAAS_SKIP_NODE_HEALTH_CHECKS=true \
    ATOMIC_SAAS_NODE_PROVIDER=local-process \
    DB_PATH="$SAAS_DB" \
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
#
# `set -e` and polling do not mix: a bare `curl ... && break` is a compound
# command whose failure aborts the whole script, so the first poll against a
# port nothing is listening on yet ends the run. Every probe is therefore
# guarded with `|| true`.
up=false

for _ in $(seq 1 300); do
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "control plane exited during startup — see $SAAS_LOG" >&2
    tail -20 "$SAAS_LOG" >&2
    exit 1
  fi

  # Any HTTP answer means it is listening; /api/me is 401 without a session.
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$SAAS_PORT/api/me" || true)

  if [[ "$code" != "000" ]]; then
    up=true
    break
  fi

  sleep 1
done

if [[ "$up" != true ]]; then
  echo "control plane did not come up — see $SAAS_LOG" >&2
  tail -20 "$SAAS_LOG" >&2
  exit 1
fi

# Without a bucket the control plane falls back to an in-memory stub whose
# upload URLs are not real. A browser test would then pass while storing
# nothing, so confirm the real backend rather than trusting the env vars.
if grep -q "in-memory stub" "$SAAS_LOG"; then
  echo "control plane fell back to the in-memory vault stub — S3 config is wrong" >&2
  grep -i vault "$SAAS_LOG" >&2
  exit 1
fi

echo "control plane up on $SAAS_PORT (log: $SAAS_LOG)"
echo
echo "Point the SPA at it with:"
echo "  VITE_MANAGED_PORTAL_URL=http://localhost:$SAAS_PORT"
