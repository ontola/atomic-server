#!/usr/bin/env bash
# Isolated, persistent services for account-first and Mac-first acceptance.
# Usage: ./scripts/mac-account-stack.sh start|status|pause-source|resume-source|stop
# The native app itself is built/launched separately; see desktop/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SAAS="${ATOMIC_SAAS_DIR:-$ROOT/../atomic-saas}"
if [[ -d /Volumes/AtomicMacAcceptance ]]; then
  DEFAULT_RUN=/Volumes/AtomicMacAcceptance/run
else
  DEFAULT_RUN=/private/tmp/atomic-mac-acceptance
fi
RUN="${ATOMIC_MAC_ACCEPTANCE_DIR:-$DEFAULT_RUN}"
MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
MINIO_NAME=atomic-mac-acceptance-minio
MINIO_BINARY="${ATOMIC_MINIO_BINARY:-$(dirname "$RUN")/bin/minio}"
MINIO_PORT=9101
API_PORT=3031
PORTAL_PORT=49238
FRONTEND_PORT=6751
NODE_PORT=9891
BUCKET=atomic-mac-acceptance
AWS_ACCESS_KEY_ID=atomic-acceptance
AWS_SECRET_ACCESS_KEY=atomic-acceptance-secret
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE="$RUN/aws-config" AWS_SHARED_CREDENTIALS_FILE="$RUN/aws-credentials"
export AWS_PAGER=''

die() { echo "$*" >&2; exit 1; }

port_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | grep -q .
}

other_frontend_writer() {
  local pid cwd
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [[ "$cwd" == "$ROOT/browser/data-browser" ]] && return 0
  done < <(pgrep -f '[v]ite' || true)
  return 1
}

wait_http() {
  local url="$1" name="$2" pid="${3:-}" code
  for _ in $(seq 1 60); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      die "$name exited; see $RUN/$name.log"
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)
    [[ "$code" != 000 ]] && return 0
    sleep 1
  done
  die "$name did not become reachable at $url; see $RUN/$name.log"
}

owned_container() {
  [[ "$(docker inspect -f '{{index .Config.Labels "io.ontola.atomic.acceptance"}}' "$MINIO_NAME" 2>/dev/null || true)" == true ]]
}

status() {
  if [[ -f "$RUN/minio.pid" ]] && kill -0 "$(cat "$RUN/minio.pid")" 2>/dev/null; then
    echo "MinIO: running locally on :$MINIO_PORT"
  elif owned_container && [[ "$(docker inspect -f '{{.State.Running}}' "$MINIO_NAME")" == true ]]; then
    echo "MinIO: running on :$MINIO_PORT"
  else
    echo "MinIO: stopped"
  fi
  for item in "api:$API_PORT" "portal:$PORTAL_PORT" "frontend:$FRONTEND_PORT"; do
    local name="${item%%:*}" port="${item##*:}"
    if [[ -f "$RUN/$name.pid" ]] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
      echo "$name: running on :$port"
    else
      echo "$name: stopped"
    fi
  done
  if [[ -f "$RUN/source-node.pid" ]] && kill -0 "$(cat "$RUN/source-node.pid")" 2>/dev/null; then
    echo "source node: running on :$NODE_PORT"
  else
    echo "source node: stopped (Vault-only restore check can run)"
  fi
  echo "Data and logs: $RUN"
}

pause_source() {
  [[ -f "$RUN/source-node.pid" ]] || return 0
  local pid command listener
  pid="$(cat "$RUN/source-node.pid")"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  listener="$(lsof -nP -iTCP:"$NODE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ "$listener" == "$pid" && "$command" == *"$ROOT/target/debug/atomic-server"* ]]; then
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && die "Source node did not stop; retained $RUN/source-node.pid"
  elif kill -0 "$pid" 2>/dev/null; then
    die "Source-node PID no longer matches its port and binary; inspect it before stopping"
  fi
  rm -f "$RUN/source-node.pid"
}

resume_source() {
  [[ -x "$ROOT/target/debug/atomic-server" ]] || die "Build atomic-server first"
  if [[ -f "$RUN/source-node.pid" ]] && kill -0 "$(cat "$RUN/source-node.pid")" 2>/dev/null; then
    die "Source node is already running"
  fi
  port_free "$NODE_PORT" || die "Port $NODE_PORT is already in use"
  mkdir -p "$RUN/source-node/data" "$RUN/source-node/config" "$RUN/source-node/cache"
  local resolved
  resolved="$("$ROOT/target/debug/atomic-server" --data-dir "$RUN/source-node/data" \
    --config-dir "$RUN/source-node/config" --cache-dir "$RUN/source-node/cache" \
    --ip 127.0.0.1 --auto-compact false show-config)"
  [[ "$resolved" == *"$RUN/source-node/data"* &&
     "$resolved" == *"$RUN/source-node/config"* ]] ||
    die "Source node did not resolve to isolated data and config paths"
  (
    cd "$ROOT"
    nohup "$ROOT/target/debug/atomic-server" --port "$NODE_PORT" --ip 127.0.0.1 \
      --data-dir "$RUN/source-node/data" --config-dir "$RUN/source-node/config" \
      --cache-dir "$RUN/source-node/cache" --auto-compact false \
      > "$RUN/source-node.log" 2>&1 &
    echo $! > "$RUN/source-node.pid"
  )
  wait_http "http://localhost:$NODE_PORT/server" source-node "$(cat "$RUN/source-node.pid")"
}

stop() {
  local name pid command port listener
  for name in frontend portal api; do
    [[ -f "$RUN/$name.pid" ]] || continue
    pid="$(cat "$RUN/$name.pid")"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$name" in
      frontend) port="$FRONTEND_PORT" ;;
      portal) port="$PORTAL_PORT" ;;
      api) port="$API_PORT" ;;
    esac
    listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ "$listener" == "$pid" ]] &&
       { [[ "$name" == api && "$command" == *atomic-saas* ]] ||
         [[ "$name" != api && "$command" == *vite* && "$command" == *"--port $port"* ]]; }; then
      kill "$pid"
    fi
    rm -f "$RUN/$name.pid"
  done
  pause_source
  if [[ -f "$RUN/minio.pid" ]]; then
    pid="$(cat "$RUN/minio.pid")"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    listener="$(lsof -nP -iTCP:"$MINIO_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ "$listener" == "$pid" && "$command" == *"$MINIO_BINARY"* ]]; then
      kill "$pid"
    elif kill -0 "$pid" 2>/dev/null; then
      die "MinIO PID no longer matches its port and binary; inspect it before stopping"
    fi
    rm -f "$RUN/minio.pid"
  fi
  if owned_container; then docker rm -f "$MINIO_NAME" >/dev/null; fi
  echo "Stopped acceptance services; retained $RUN"
}

start() {
  [[ -d "$SAAS" ]] || die "atomic-saas checkout missing: $SAAS"
  [[ -x "$SAAS/target/debug/atomic-saas" ]] || die "Build atomic-saas first: cd $SAAS && cargo build --bin atomic-saas"
  [[ -x "$SAAS/portal/node_modules/.bin/vite" ]] || die "Install portal dependencies in $SAAS/portal"
  [[ -x "$ROOT/browser/data-browser/node_modules/.bin/vite" ]] || die "Install browser dependencies in $ROOT/browser"
  [[ -x "$ROOT/target/debug/atomic-server" ]] || die "Build the source atomic-server first"
  other_frontend_writer && die "Another Vite process is serving this checkout; stop it before starting acceptance"
  command -v aws >/dev/null || die "AWS CLI is required for the S3 smoke check"
  for port in "$MINIO_PORT" 9102 "$API_PORT" "$PORTAL_PORT" "$FRONTEND_PORT" "$NODE_PORT"; do
    port_free "$port" || die "Port $port is already in use; no service was replaced"
  done
  mkdir -p "$RUN/minio"
  chmod 700 "$RUN"
  local free_kib
  free_kib="$(df -Pk "$RUN" | awk 'NR == 2 { print $4 }')"
  (( free_kib >= 10 * 1024 * 1024 )) ||
    die "Only $((free_kib / 1024 / 1024)) GiB free on the acceptance volume; MinIO rejects writes near full. Free at least 10 GiB there."
  if [[ ! -f "$RUN/vault-salt" ]]; then
    umask 077
    openssl rand -hex 32 > "$RUN/vault-salt"
  fi

  if [[ -x "$MINIO_BINARY" ]]; then
    nohup env MINIO_ROOT_USER="$AWS_ACCESS_KEY_ID" \
      MINIO_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY" \
      MINIO_API_CORS_ALLOW_ORIGIN='http://tauri.localhost,tauri://localhost,http://localhost:6751' \
      "$MINIO_BINARY" server --address "127.0.0.1:$MINIO_PORT" \
      --console-address 127.0.0.1:9102 "$RUN/minio" > "$RUN/minio.log" 2>&1 &
    echo $! > "$RUN/minio.pid"
    wait_http "http://localhost:$MINIO_PORT/minio/health/live" minio "$(cat "$RUN/minio.pid")"
  else
    command -v docker >/dev/null || die "MinIO binary missing ($MINIO_BINARY) and Docker unavailable"
    docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 || die "Missing pinned MinIO image: $MINIO_IMAGE"
    if docker inspect "$MINIO_NAME" >/dev/null 2>&1; then
      die "Container $MINIO_NAME already exists; inspect it before starting another stack"
    fi
    docker run -d --name "$MINIO_NAME" \
      --label io.ontola.atomic.acceptance=true \
      -p "127.0.0.1:$MINIO_PORT:9000" \
      -e MINIO_ROOT_USER="$AWS_ACCESS_KEY_ID" \
      -e MINIO_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY" \
      -e MINIO_API_CORS_ALLOW_ORIGIN='http://tauri.localhost,tauri://localhost,http://localhost:6751' \
      -v "$RUN/minio:/data" "$MINIO_IMAGE" server /data >/dev/null
    wait_http "http://localhost:$MINIO_PORT/minio/health/live" minio
  fi
  aws --endpoint-url "http://localhost:$MINIO_PORT" s3api head-bucket --bucket "$BUCKET" 2>/dev/null ||
    aws --endpoint-url "http://localhost:$MINIO_PORT" s3api create-bucket --bucket "$BUCKET" >/dev/null
  # This pinned community MinIO image supports global CORS but returns
  # NotImplemented for PutBucketCors. Verify the browser preflight below.
  printf 'vault acceptance %s\n' "$(date -u +%FT%TZ)" > "$RUN/s3-probe.txt"
  aws --endpoint-url "http://localhost:$MINIO_PORT" s3api put-object \
    --bucket "$BUCKET" --key setup-probe --body "$RUN/s3-probe.txt" >/dev/null
  aws --endpoint-url "http://localhost:$MINIO_PORT" s3api get-object \
    --bucket "$BUCKET" --key setup-probe "$RUN/s3-probe-read.txt" >/dev/null
  cmp "$RUN/s3-probe.txt" "$RUN/s3-probe-read.txt" || die "S3 bytes changed on round trip"
  aws --endpoint-url "http://localhost:$MINIO_PORT" s3api delete-object \
    --bucket "$BUCKET" --key setup-probe >/dev/null
  local origin
  for origin in tauri://localhost http://tauri.localhost http://localhost:6751; do
    curl -sf -X OPTIONS "http://localhost:$MINIO_PORT/$BUCKET/cors-probe" \
      -H "Origin: $origin" -H 'Access-Control-Request-Method: PUT' \
      -H 'Access-Control-Request-Headers: content-type' -D "$RUN/cors-headers" -o /dev/null
    grep -qi "access-control-allow-origin: $origin" "$RUN/cors-headers" ||
      die "MinIO PUT CORS preflight failed for $origin"
  done

  resume_source

  (
    cd "$SAAS"
    nohup env SENTRY_DSN= SENTRY_DSN_BROWSER= ATOMIC_SAAS_LOAD_DEV_ENV=true \
      ATOMIC_SAAS_PORT="$API_PORT" SAAS_URL="http://localhost:$PORTAL_PORT" \
      DB_PATH="$RUN/saas.redb" POSTMARK_TOKEN=mock \
      ATOMIC_SAAS_NODE_PROVIDER=local-process ATOMIC_SAAS_DEV_MAGIC_LINKS=true \
      ATOMIC_SAAS_SIGNUP_PER_IP_CAP=10000 ATOMIC_SAAS_SIGNUP_EMAIL_COOLDOWN_SECS=0 \
      ATOMIC_SAAS_SKIP_NODE_HEALTH_CHECKS=true \
      ATOMIC_SAAS_DEV_NODE_ORIGIN="http://localhost:$NODE_PORT" \
      ATOMIC_APP_HOST="localhost:$FRONTEND_PORT" \
      ATOMIC_VAULT_REQUIRE_S3=1 ATOMIC_VAULT_S3_BUCKET="$BUCKET" \
      ATOMIC_VAULT_S3_REGION=us-east-1 \
      ATOMIC_VAULT_S3_ENDPOINT="http://localhost:$MINIO_PORT" \
      ATOMIC_VAULT_S3_ALLOW_HTTP=1 \
      ATOMIC_VAULT_S3_VIRTUAL_HOSTED=0 \
      ATOMIC_VAULT_S3_ACCESS_KEY="$AWS_ACCESS_KEY_ID" \
      ATOMIC_VAULT_S3_SECRET_KEY="$AWS_SECRET_ACCESS_KEY" \
      ATOMIC_VAULT_PSEUDONYM_SALT="$(cat "$RUN/vault-salt")" \
      "$SAAS/target/debug/atomic-saas" > "$RUN/api.log" 2>&1 &
    echo $! > "$RUN/api.pid"
  )
  wait_http "http://localhost:$API_PORT/api/me" api "$(cat "$RUN/api.pid")"
  grep -q 'in-memory stub' "$RUN/api.log" && die "SaaS fell back to the Vault stub"
  for origin in tauri://localhost http://tauri.localhost; do
    curl -sf -X OPTIONS "http://localhost:$API_PORT/api/me" \
      -H "Origin: $origin" -H 'Access-Control-Request-Method: GET' \
      -D "$RUN/api-cors-headers" -o /dev/null
    grep -qi "access-control-allow-origin: $origin" "$RUN/api-cors-headers" ||
      die "SaaS does not allow the packaged Tauri origin $origin"
  done

  (
    cd "$SAAS/portal"
    nohup env ATOMIC_SAAS_API_ORIGIN="http://127.0.0.1:$API_PORT" \
      VITE_ATOMIC_APP_URL="http://localhost:$FRONTEND_PORT" \
      ./node_modules/.bin/vite --host 127.0.0.1 --port "$PORTAL_PORT" --strictPort \
      > "$RUN/portal.log" 2>&1 &
    echo $! > "$RUN/portal.pid"
  )
  wait_http "http://127.0.0.1:$PORTAL_PORT/" portal "$(cat "$RUN/portal.pid")"

  (
    cd "$ROOT/browser/data-browser"
    nohup env TAURI=1 VITE_MANAGED_PORTAL_URL="http://localhost:$PORTAL_PORT" \
      VITE_MANAGED_API_BASE="http://localhost:$API_PORT/api" \
      VITE_ATOMIC_SERVER_URL="http://localhost:$NODE_PORT" VITE_SENTRY_DSN= \
      ./node_modules/.bin/vite --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort \
      > "$RUN/frontend.log" 2>&1 &
    echo $! > "$RUN/frontend.pid"
  )
  wait_http "http://127.0.0.1:$FRONTEND_PORT/" frontend "$(cat "$RUN/frontend.pid")"
  echo "S3 PUT/GET and MinIO (3 origins)/API (2 origins) CORS preflights passed."
  status
}

case "${1:-}" in
  start) start ;;
  status) status ;;
  pause-source) pause_source; status ;;
  resume-source) resume_source; status ;;
  stop) stop ;;
  *) die "Usage: $0 start|status|pause-source|resume-source|stop" ;;
esac
