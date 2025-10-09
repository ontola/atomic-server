#!/bin/bash
# Run local-only e2e tests that work with the local server

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Running local-only E2E tests${NC}"

# Setup test directories
TEST_DATA_DIR="/tmp/atomic-test-data-$(date +%s)"
TEST_CACHE_DIR="/tmp/atomic-test-cache-$(date +%s)"

echo "Creating test directories..."
mkdir -p "$TEST_DATA_DIR"
mkdir -p "$TEST_CACHE_DIR"

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    
    # Kill processes if they're running
    if [[ ! -z "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "Stopping atomic-server..."
        kill "$SERVER_PID" || true
    fi
    
    if [[ ! -z "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "Stopping frontend dev server..."
        kill "$FRONTEND_PID" || true
    fi
    
    # Clean up test data
    echo "Removing test directories..."
    rm -rf "$TEST_DATA_DIR"
    rm -rf "$TEST_CACHE_DIR"
    
    echo -e "${GREEN}Cleanup complete${NC}"
}

trap cleanup EXIT

# Build the server in debug mode (required for prune endpoint)
echo -e "${YELLOW}Building atomic-server in debug mode...${NC}"
cargo build --bin atomic-server

# Start atomic-server with test configuration
echo -e "${YELLOW}Starting atomic-server on port 9883...${NC}"
./target/debug/atomic-server \
    --port 9883 \
    --data-dir "$TEST_DATA_DIR" \
    --cache-dir "$TEST_CACHE_DIR" \
    --log-level info \
    --rebuild-indexes \
    --public-mode &

SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server to be ready
echo "Waiting for server to be ready..."
MAX_ATTEMPTS=30
ATTEMPT=0
while ! curl -s "http://localhost:9883" > /dev/null 2>&1; do
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
        echo -e "${RED}Server failed to start after ${MAX_ATTEMPTS} attempts${NC}"
        exit 1
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
done
echo -e "${GREEN}Server is ready!${NC}"

# Check if the server has the prune endpoint
echo "Checking for prune endpoint..."
if curl -s "http://localhost:9883/prunetests" | grep -q "prune"; then
    echo -e "${GREEN}Prune endpoint is available${NC}"
else
    echo -e "${YELLOW}Warning: Prune endpoint may not be available${NC}"
fi

# Install frontend dependencies if needed
cd browser
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    pnpm install
fi

# Start frontend dev server
echo -e "${YELLOW}Starting frontend dev server on port 5173...${NC}"
NODE_ENV=development pnpm dev &
FRONTEND_PID=$!
echo "Frontend PID: $FRONTEND_PID"

# Wait for frontend to be ready
echo "Waiting for frontend to be ready..."
MAX_ATTEMPTS=30
ATTEMPT=0
while ! curl -s "http://localhost:5173" > /dev/null 2>&1; do
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
        echo -e "${RED}Frontend failed to start after ${MAX_ATTEMPTS} attempts${NC}"
        exit 1
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
done
echo -e "${GREEN}Frontend is ready!${NC}"

# Run the local e2e tests
echo -e "${YELLOW}Running local E2E tests...${NC}"

# Change to e2e directory where tests actually are
cd e2e

# Set environment variables for the tests
export VITE_SERVER_URL="http://localhost:9883"
export VITE_FRONTEND_URL="http://localhost:5173"
export DELETE_PREVIOUS_TEST_DRIVES=false  # Skip prune tests

# Run only the local test file
echo "Running local test file: tests/e2e.spec.local.ts"
pnpm exec playwright test tests/e2e.spec.local.ts --reporter=list || TEST_FAILED=true

# Also run tests that should work locally
echo -e "${YELLOW}Running additional compatible tests...${NC}"

# Run specific test files that should work locally
echo "Running keyboard navigation tests"
pnpm exec playwright test tests/e2e.spec.ts \
    --grep "keyboard|navigation" \
    --grep-invert "atomicdata.dev" \
    --reporter=list || TEST_FAILED=true

echo "Running document tests"
pnpm exec playwright test tests/documents.spec.ts \
    --reporter=list || TEST_FAILED=true

echo "Running table tests"
pnpm exec playwright test tests/tables.spec.ts \
    --reporter=list || TEST_FAILED=true

if [ "$TEST_FAILED" = true ]; then
    echo -e "${RED}Some tests failed${NC}"
    exit 1
else
    echo -e "${GREEN}All local tests passed!${NC}"
fi