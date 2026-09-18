#!/bin/bash
# Start the e2e atomic-server on 9897 and do not return until it answers HTTP 200.
# redb's lock outlives the listening socket, so retry the spawn, not just the wait.
set -u
DATA=/private/tmp/atomic-hosting-node
BIN=/private/tmp/atomic-website-rust-build/debug/atomic-server
LOG=/tmp/server-9897.log

if curl -s --max-time 2 -o /dev/null -w '' http://localhost:9897/ 2>/dev/null; then
  code=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:9897/)
  [ "$code" = "200" ] && { echo "already up"; exit 0; }
fi

for attempt in 1 2 3 4 5 6; do
  cd "$DATA" || exit 1
  ATOMIC_WEBSITE_ORIGIN=http://sites.localhost:9897 \
  ATOMIC_INITIALIZE=true \
  ATOMIC_INTEGRATION_PROXY_URL=http://127.0.0.1:19090 \
  TENANT_SECRET='bW9jay10ZW5hbnQ.mock-signature' \
  ATOMIC_INTEGRATION_FRONTEND_ORIGIN=http://localhost:6763 \
  nohup "$BIN" --port 9897 --ip 127.0.0.1 \
    --data-dir "$DATA/data" --config-dir "$DATA/config" --cache-dir "$DATA/cache" \
    > "$LOG" 2>&1 &
  for i in $(seq 1 25); do
    code=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:9897/ 2>/dev/null)
    [ "$code" = "200" ] && { echo "server up (attempt $attempt, ${i}s)"; exit 0; }
    sleep 1
  done
  if grep -q "Database already open" "$LOG"; then
    echo "attempt $attempt: redb lock still held, retrying"
    sleep 5
    continue
  fi
  echo "attempt $attempt: did not become healthy"; tail -5 "$LOG"; sleep 3
done
echo "FAILED to start server"; tail -20 "$LOG"; exit 1
