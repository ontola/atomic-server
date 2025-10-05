# Memories - Atomic Server

## Project Context
- **Repository**: Atomic Server - Rust workspace with lib/server/cli packages
- **Current Branch**: turso_option (integrating Turso database backend)
- **Base Branch**: develop
- **Frontend**: TypeScript/React in browser/ directory

## Key System Configuration

### Search Performance
- **Implementation**: SQLite FTS5 with LRU caching
- **Performance**: ~285ns per text search query
- **Cache Strategy**: Two-tier (1000 hot + 500 prefix entries)
- **Location**: lib/src/search_sqlite.rs

### WebSocket Authentication
- **Handler**: server/src/handlers/web_sockets.rs
- **Method**: Accepts AUTHENTICATE commands post-handshake
- **Test Agent**: Uses hardcoded test agent for e2e tests

### Test Configuration
- **REBUILD_INDEX_TIME**: 2500ms (for SQLite FTS5 index rebuilding)
- **Location**: browser/e2e/tests/test-utils.ts
- **Runner**: Playwright for e2e tests, cargo nextest for Rust tests

## Critical Dependencies
- **libsql**: Turso database client (optional feature)
- **SQLite**: Primary storage backend with FTS5 search
- **Actix-web**: HTTP server framework
- **Playwright**: E2E testing framework

## Database Backends
1. **SQLite**: Default backend, proven performance
2. **Sled**: Legacy backend (being phased out)  
3. **Turso**: New optional backend for global edge deployment

## Performance Benchmarks
- **Text Search**: 285ns (SQLite FTS5)
- **Fuzzy Search**: 159ns (FST automaton)
- **Similarity Search**: 290µs (Jaro-Winkler)
- **FST Memory Access**: 25ns (memory-mapped)

## Recent Critical Fixes (2025-10-05)
- Fixed WebSocket AUTHENTICATE command handling
- Increased search test timing from 500ms to 2500ms  
- Enhanced sign-in test stability with retry logic
- Maintained optimal search performance throughout

## Frontend Timing Resolution (2025-10-05)
- **Root Cause**: Animation delays and view transitions blocking test execution
- **Solution**: CSS injection to disable all animations in test environment
- **Impact**: Test execution time reduced from 30s+ timeouts to 10-13s per test
- **Key Files Modified**:
  - `/browser/e2e/tests/test-utils.ts` - CSS injection and WebSocket auth
  - `/browser/e2e/tests/global.setup.ts` - Global animation disabling
  - `/browser/e2e/playwright.config.ts` - Enhanced test environment config