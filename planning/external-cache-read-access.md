# External cache read access (#170)

- [x] Trace fetch and collection read paths on develop after #1460.
- [x] Add regression coverage for cached private external resources in public and authenticated collection queries, including nested results.
- [x] Check whether implicit external fetches send the node's default-agent credentials and whether that changes disclosure behavior.
- [x] Replace the demonstrated URL-prefix authentication bug with parsed origin comparison.
- [x] Run library tests (524 passed, 7 ignored) and update TESTING_COVERAGE.md.
- [ ] Finish Clippy and CI, then merge the focused PR.

Current findings: Storelike::fetch_resource persists primary and referenced
resources. Db::get_resource may pass the default agent to an external fetch.
Db::resolve_query_member checks each cached row through check_rights_cached;
its fallback uses get_resource_extended, which also checks read access.
No current disclosure has been reproduced yet. Do not remove authenticated
client fetch support based only on the original issue's historical description.

The cache ACL regression passes on existing code. A separate origin-boundary
regression fails on the string-prefix check: example.com.evil.test is accepted
for example.com. Replace that predicate with parsed HTTP(S) origin equality.
Full library validation is running; no private cache disclosure reproduced.
