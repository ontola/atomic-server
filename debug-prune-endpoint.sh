#!/bin/bash

# Simple script to test if the prune endpoint is available
set -e

echo "🔍 Testing prune endpoint availability..."

# Clean up any existing test data directories
rm -rf /tmp/atomic-debug-data /tmp/atomic-debug-cache
mkdir -p /tmp/atomic-debug-data /tmp/atomic-debug-cache

echo "🚀 Starting atomic-server in debug mode on port 9883..."

cargo run --bin atomic-server -- \
    --port 9883 \
    --data-dir /tmp/atomic-debug-data \
    --cache-dir /tmp/atomic-debug-cache \
    --log-level debug &

SERVER_PID=$!

echo "Server PID: $SERVER_PID"

# Function to cleanup
cleanup() {
    echo "🧹 Cleaning up..."
    if [ ! -z "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf /tmp/atomic-debug-data /tmp/atomic-debug-cache
}

trap cleanup EXIT

# Wait for server to be ready
echo "⏳ Waiting for server to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:9883 >/dev/null 2>&1; then
        echo "✅ Server is ready"
        break
    fi
    echo -n "."
    sleep 1
done

echo
echo "🧪 Testing endpoints:"

echo -n "1. Root endpoint: "
if curl -s http://localhost:9883 >/dev/null; then
    echo "✅"
else
    echo "❌"
fi

echo -n "2. Prune endpoint (GET): "
if curl -s http://localhost:9883/prunetests >/dev/null; then
    echo "✅"
else
    echo "❌"
fi

echo -n "3. App endpoint: "
if curl -s http://localhost:9883/app >/dev/null; then
    echo "✅"
else
    echo "❌"
fi

echo -n "4. App prune endpoint: "
if curl -s http://localhost:9883/app/prunetests >/dev/null; then
    echo "✅"
else
    echo "❌"
fi

echo
echo "📋 Testing detailed responses:"

echo "Root response (first 200 chars):"
curl -s http://localhost:9883 | head -c 200
echo

echo "Prune endpoint response:"
curl -s http://localhost:9883/prunetests || echo "Failed to access /prunetests"
echo

echo "App prune endpoint response:"
curl -s http://localhost:9883/app/prunetests || echo "Failed to access /app/prunetests"
echo

echo "✅ Test completed"