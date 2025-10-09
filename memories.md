# Memories - Atomic Server Test Fixes

[v1.0.0] Development: Initial exploration of atomic-server project revealed it's a Rust-based server with React/TypeScript frontend, discovered multiple specialized AI agents for development roles, found testing infrastructure with Rust tests passing but E2E tests failing due to server connection issues at port 9883 and frontend dev server conflicts at port 5173.

[v1.0.1] Development: Created comprehensive test fix plan in TEST_FIX_PLAN.md, identified main issues as prune test UI not rendering "Prune Test Data" text at /app/prunetests route, authentication tests failing due to external atomicdata.dev dependencies, port conflicts from previous test runs, and test discovery issues with Playwright not finding new test files.

[v1.0.2] Development: Implemented robust test runners - created run-all-tests.sh as comprehensive test runner with automatic cleanup, run-local-e2e-tests.sh for E2E-specific testing, and e2e.spec.local.ts for local-only test suite without external dependencies. Fixed port management by adding automatic cleanup of ports 5173 and 9883 using lsof commands.

[v1.0.3] Development: Fixed test discovery issues by running tests from correct e2e directory, created TEST_STATUS.md documenting current state with Rust tests passing and E2E tests partially working. Identified remaining issues including search timing problems, prune test UI rendering, and external service dependencies.

[v1.0.4] Development: Created auth-security.spec.ts with comprehensive authentication and security tests including agent creation, persistence verification, access control for private/public drives, sign-out cleanup, and write permission validation - all designed to work with local server without external dependencies.

[v1.0.5] Development: Set up todo list for fixing critical security and search functionality, focusing on authentication flow improvements and search timing issues with proper wait conditions and retry logic. Priority given to security features as critical infrastructure.

[v1.0.6] Development: Created search-improved.spec.ts with comprehensive retry logic and proper timing for search tests, implementing waitForSearchIndex helper with 3-5 second delays for SQLite FTS5 index rebuilding, searchWithRetry function with 5 attempts and 1 second delays, and tests for text search, scoped search, tag search, and index persistence after reload - all designed to handle asynchronous search operations reliably.

[v1.0.7] Development: Verified complete migration to SQLite database - confirmed all 127 Rust tests passing, SQLite database file present at store.db with proper tables (resources, search_index, prop_val_sub, val_prop_sub, query_members, watched_queries, fst_index), 2072 resources successfully stored, search using SQLite FTS5 full-text search confirmed working, WAL mode enabled for better concurrency. E2E tests partially passing with document tests working, some timing issues remain with complex table and auth tests but core functionality verified.

[v1.0.8] Development: Fixed major test timing issue - discovered FTS5 index updates are instant (0.65ms per resource), not requiring seconds of wait time. Updated all search tests to use 100-200ms delays instead of 2500-5000ms, reducing test execution time dramatically. FTS5 uses INSERT OR REPLACE which is immediate, tests were waiting unnecessarily for "index rebuilds" that don't exist. Measured actual performance: 200 resources indexed in 130ms.

[v1.0.9] Development: Completed comprehensive E2E test timing improvements - confirmed FTS5 instant updates through log analysis and test runs, all 127 Rust tests passing, search persistence test passing confirming FTS5 operations work correctly, reduced test delays from several seconds to 100-200ms throughout search-improved.spec.ts/search.spec.ts/test-utils.ts. Some E2E tests still failing due to UI timing issues unrelated to search indexing, particularly in authentication flows and table interactions where UI elements fail to render in expected timeframes.
