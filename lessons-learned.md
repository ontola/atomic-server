# Lessons Learned - Atomic Server Test Fixes

[2025-10-07 15:00] Testing Infrastructure: Issue: E2E tests failing with connection refused errors on port 9883 → Fix: Server wasn't running, needed to create automated test runners with proper server startup and port management → Why: Critical for reliable test execution and preventing false failures due to infrastructure issues rather than actual code problems.

[2025-10-07 15:10] Port Management: Issue: Port 5173 already in use errors causing frontend dev server failures → Fix: Implement automatic port cleanup using lsof and kill commands before starting tests → Why: Essential for test reliability, prevents test failures from lingering processes and ensures clean test environment.

[2025-10-07 15:15] Test Discovery: Issue: Playwright couldn't find newly created test files → Fix: Run tests from correct e2e directory and use proper path structure tests/filename.spec.ts → Why: Playwright configuration expects tests in specific location, understanding test directory structure is crucial for test organization.

[2025-10-07 15:18] Authentication Testing: Issue: Tests trying to use external atomicdata.dev site causing failures → Fix: Create local-only test suite using /setup endpoint for authentication without external dependencies → Why: Tests should be self-contained and not rely on external services for reliability and speed.

[2025-10-07 15:20] Search Index Timing: Issue: Search tests failing due to timing issues with SQLite FTS5 index rebuilding → Fix: Increase REBUILD_INDEX_TIME to 2500ms and add retry logic for search operations → Why: Database index operations are asynchronous and need proper wait conditions to avoid race conditions.

[2025-10-07 15:21] Security Testing: Issue: Access control tests needed for authentication and authorization → Fix: Created comprehensive auth-security.spec.ts with tests for agent creation, persistence, access control, and permissions → Why: Security is critical infrastructure that must be thoroughly tested to prevent unauthorized access and data breaches.

[2025-10-07 15:22] Search Retry Logic: Issue: Search tests failing intermittently due to async index operations → Fix: Implemented searchWithRetry helper with 5 attempts and 1 second delays between retries, plus waitForSearchIndex with page reload to ensure index refresh → Why: Asynchronous operations require robust retry mechanisms to handle timing variations and ensure test reliability across different system speeds.

[2025-10-07 15:32] SQLite Migration Verification: Issue: Need to confirm complete migration from Sled to SQLite → Fix: Verified database structure with proper tables (resources, search_index with FTS5, index tables), confirmed 2072 resources stored, WAL mode enabled for concurrency → Why: SQLite provides better performance, reliability, and standard SQL querying capabilities compared to Sled, essential for production use.

[2025-10-07 15:42] FTS5 Instant Updates: Issue: Tests waiting 2.5-5 seconds for "index rebuilds" that don't exist → Fix: Discovered FTS5 updates are instant via INSERT OR REPLACE (0.65ms per resource), reduced all test wait times to 100-200ms → Why: Major misconception about FTS5 - it doesn't need rebuild time, updates are immediate, tests were wasting time waiting for nothing, actual indexing speed is 200 resources in 130ms.

[2025-10-07 15:52] FTS5 Performance Confirmed: Issue: Need to validate FTS5 timing improvements work in practice → Fix: Confirmed through server logs and test runs that FTS5 operations are indeed instant, search persistence test passes showing index correctly maintained, UI timing issues in E2E tests are unrelated to indexing → Why: Important to distinguish between database performance (excellent) and UI rendering issues (separate problem), FTS5 performance is not the bottleneck in failed tests.
