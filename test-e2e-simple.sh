#!/bin/bash
# Simple e2e test runner that skips the prune tests step
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎭 Running simplified E2E tests (skipping prune tests)${NC}"

# Start the servers using our existing test runner infrastructure
echo "Starting servers..."

# Clean up any existing test data directories
rm -rf /tmp/atomic-test-data /tmp/atomic-test-cache
mkdir -p /tmp/atomic-test-data /tmp/atomic-test-cache

# Start atomic-server
cargo run --bin atomic-server -- \
    --port 9883 \
    --data-dir /tmp/atomic-test-data \
    --cache-dir /tmp/atomic-test-cache \
    --log-level info > /tmp/atomic-server-simple.log 2>&1 &
SERVER_PID=$!

# Function to cleanup
cleanup() {
    echo -e "\n${YELLOW}🧹 Cleaning up...${NC}"
    if [ ! -z "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ ! -z "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" || true
        wait "$FRONTEND_PID" 2>/dev/null || true
    fi
    rm -rf /tmp/atomic-test-data /tmp/atomic-test-cache
    echo -e "${GREEN}✅ Cleanup completed${NC}"
}

trap cleanup EXIT

# Wait for server to be ready
echo "⏳ Waiting for server to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:9883 >/dev/null 2>&1; then
        echo "✅ Server is ready"
        break
    fi
    sleep 1
done

# Start frontend dev server
cd browser
pnpm dev > /tmp/frontend-simple.log 2>&1 &
FRONTEND_PID=$!

# Wait for frontend to be ready
echo "⏳ Waiting for frontend to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:5173 >/dev/null 2>&1; then
        echo "✅ Frontend is ready"
        break
    fi
    sleep 1
done

echo

# Set environment variables for the tests but disable the prune test step
export SERVER_URL="http://localhost:9883"
export FRONTEND_URL="http://localhost:5173" 
export DELETE_PREVIOUS_TEST_DRIVES="false"  # This is the key change
export NODE_ENV="development"
export MODE="development"

echo -e "${BLUE}Running E2E tests with prune step disabled...${NC}"

# Run the e2e tests
if pnpm test-e2e; then
    echo -e "${GREEN}✅ E2E tests completed successfully${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  Some E2E tests failed${NC}"
    exit 1
fi