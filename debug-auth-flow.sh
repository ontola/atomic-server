#!/bin/bash
# Debug script to test authentication flow

set -e

echo "🔍 Debugging Authentication Flow..."

# Start servers
echo "Starting servers..."
rm -rf /tmp/atomic-auth-test-data /tmp/atomic-auth-test-cache
mkdir -p /tmp/atomic-auth-test-data /tmp/atomic-auth-test-cache

# Start atomic-server
cargo run --bin atomic-server -- \
    --port 9883 \
    --data-dir /tmp/atomic-auth-test-data \
    --cache-dir /tmp/atomic-auth-test-cache \
    --log-level debug > /tmp/atomic-auth-test.log 2>&1 &
SERVER_PID=$!

# Function to cleanup
cleanup() {
    echo "🧹 Cleaning up..."
    if [ ! -z "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" || true
    fi
    if [ ! -z "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" || true
    fi
    rm -rf /tmp/atomic-auth-test-data /tmp/atomic-auth-test-cache
}

trap cleanup EXIT

# Wait for server
echo "⏳ Waiting for server..."
for i in {1..30}; do
    if curl -s http://localhost:9883 >/dev/null 2>&1; then
        echo "✅ Server is ready"
        break
    fi
    sleep 1
done

# Start frontend dev server
cd browser
pnpm dev > /tmp/frontend-auth-test.log 2>&1 &
FRONTEND_PID=$!

# Wait for frontend
echo "⏳ Waiting for frontend..."
for i in {1..30}; do
    if curl -s http://localhost:5173 >/dev/null 2>&1; then
        echo "✅ Frontend is ready"
        break
    fi
    sleep 1
done

echo
echo "📋 Testing Authentication Endpoints:"
echo

# Test setup endpoint
echo "1. Testing /setup endpoint:"
SETUP_RESPONSE=$(curl -s http://localhost:9883/setup)
if echo "$SETUP_RESPONSE" | grep -q "invite" || echo "$SETUP_RESPONSE" | grep -q "Accept"; then
    echo "   ✅ /setup endpoint exists"
else
    echo "   ❌ /setup endpoint not found or has unexpected content"
fi

# Check if setup invite exists
echo
echo "2. Checking setup invite in JSON:"
SETUP_JSON=$(curl -s -H "Accept: application/json" http://localhost:9883/setup)
echo "   Response (first 200 chars): ${SETUP_JSON:0:200}"

# Test changing to atomicdata.dev (this should fail in our local test)
echo
echo "3. Testing external drive switch (should fail):"
curl -s http://localhost:9883 -H "X-Drive: https://atomicdata.dev" | head -c 200

echo
echo
echo "4. Run simple authentication test with Playwright:"
cd /home/alex/projects/terraphim/atomic-server/browser

# Create a simple test file
cat > /tmp/auth-debug-test.js << 'EOF'
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('1. Going to localhost:9883...');
  await page.goto('http://localhost:9883');
  await page.waitForTimeout(2000);
  
  console.log('2. Checking for setup invite...');
  try {
    await page.goto('http://localhost:9883/setup');
    await page.waitForTimeout(2000);
    
    const content = await page.content();
    if (content.includes('Accept')) {
      console.log('   ✅ Found Accept button or text');
    } else {
      console.log('   ❌ Accept button not found');
    }
    
    // Take a screenshot
    await page.screenshot({ path: '/tmp/setup-page.png' });
    console.log('   Screenshot saved to /tmp/setup-page.png');
  } catch (e) {
    console.log('   Error accessing setup:', e.message);
  }
  
  console.log('3. Trying to switch to atomicdata.dev...');
  try {
    // Try to open drive config
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(2000);
    
    const driveButton = await page.locator('[data-test="sidebar-drive-open"]').isVisible();
    if (driveButton) {
      console.log('   ✅ Drive button found');
    } else {
      console.log('   ❌ Drive button not found');
    }
    
    // Take a screenshot
    await page.screenshot({ path: '/tmp/frontend-page.png' });
    console.log('   Screenshot saved to /tmp/frontend-page.png');
  } catch (e) {
    console.log('   Error with frontend:', e.message);
  }
  
  await browser.close();
})();
EOF

# Only run playwright test if it's installed
if [ -f "node_modules/@playwright/test/lib/cli.js" ]; then
    echo "Running Playwright test..."
    node /tmp/auth-debug-test.js
else
    echo "Playwright not installed, skipping browser test"
fi

echo
echo "📊 Server logs (last 20 lines):"
tail -20 /tmp/atomic-auth-test.log

echo
echo "✅ Debug session complete. Check /tmp/*.png for screenshots if Playwright ran."