# remoteStorage host conditional writes

- [x] Reproduce and close the check/commit gap for conditional blob writes.
- [x] Add a clone-local DB check under the ordinary subject write lock.
- [x] Recheck current blob state at commit; classify no-write failures as 412.
- [x] Require one conditional target and persistent identity for creates.
- [x] Preserve the losing request's source bytes; only the winning resource is referenced.
- [x] Run real QuickJS/WASM route regressions and DB lock tests.
- [ ] Run the real remoteStorage installation's browser consent/API suite on this host.
- [ ] Review and land through the AtomicServer maintainer workflow; do not merge automatically.

The test fixture originally used only the intent's localId, which is a
within-verdict reference. It now writes the persistent localId property used by
the real plugin. That property plus parent is checked under the DB identity lock.
A missing persistent identity is refused for a conditional create. Multi-resource
conditional plans are refused because these operations do not offer a transaction.

API tests used the actual embedded plugin runtime and skipped the browser build.
An ignored static index fixture satisfied compile-time asset inclusion; no claim
of browser acceptance follows from these tests. See TESTING_COVERAGE.md.
