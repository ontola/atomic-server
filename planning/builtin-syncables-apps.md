# Built-in Syncables: final validation and CI handoff

## Accepted contract (2026-11-19)

Drive → provider App → authenticated principal or Public → catalog-declared
collections. No extra Accounts level or synthetic personal-owner grouping.
Authenticated Principal metadata supplies durable typed identity. CRUD references
and standard OpenAPI response Links describe organization → repositories → Issues
navigation. Provider code is declarative catalog data, not downloaded JavaScript.

The bundled `syncables/browser` dependency owns metadata discovery, selected
collection binding, pagination and typed projection. Atomic owns storage,
provisioning, UI and permissions. Sync executes in the existing opaque AppFrame
bridge; native Syncable Collection views render saved Atomic data without
refreshing a provider. Provider tokens remain at the proxy; browser connection
keys stay outside the frame. Writes retain the selected root/descendant boundary.
Canonical source identities are independent of mutable resource parents and
provider transport addresses.

## Owned source and dependencies

- Server: `codex/builtin-syncables-completion`, existing PR #2522, base for this
  refactor `43eb0306c0555f45db77ee2ed5dd8ddde1d168c6`.
- Library/catalog: paired atomic-plugins PR #747, branch
  `codex/catalog-principal-collections`, source `99a9b88dac111ebaa2536046a417030eb6ff63b8`.
  Merged as `4f7ceb8100cb461e3e0b3e223bcfaaa4b6883935`; npm
  `syncables@0.29.0` is published, pinned and installed with a frozen lockfile.
  Registry archive bytes match the tested candidate and its provenance names
  the merged source and official publishing workflow. Previous PR #734 and release 0.28.0 are already published.
- New immutable IAP profile: `2026-11-19-collection-navigation.json`. Other
  providers and historical published profiles are unchanged. The new GitHub
  profile replaces legacy owner-path CRUD annotations with canonical read
  navigation. GitHub's Issues endpoint includes pull requests; the metadata
  and raw table explicitly show both, without a provider filter in the app.
- Catalog-only deployment: owned SaaS ops branch
  `codex/builtin-syncables-catalog-deploy`; preserve runtime, OAuth/vault,
  agent permissions and other provider profiles.

## Implementation and review

- [x] Generic principal/collection/navigation/read-scope library APIs.
- [x] Immutable GitHub relationship and anonymous entrypoint metadata.
- [x] Direct App principal/Public layout and verified Accounts compatibility.
- [x] Generic iframe reconciliation, generated Atomic vocabulary and reconnect.
- [x] Fresh trusted-catalog route checks and principal verification at host.
- [x] Legacy alias discovery/fingerprints, idempotence and duplicate prevention.
- [x] Independent security review; fixed empty POST-object scope and malformed
  client-context regressions in the library candidate.
- [x] Data Browser typecheck, scoped lint, full formatting and translations.
- [x] All 2,834 Data Browser tests plus 2 MCP checks pass with npm 0.29.0 in UTC.
- [ ] Fresh matching native build and Chromium journeys/screenshots.
- [x] Publish library after required CI; pin exact registry version/lockfile.
- [x] Publish catalog and verify catalog-only live replacement (SaaS run
  44520913028): 17 providers retained, runtime/public key unchanged.
- [ ] Commit server changes, update PR/issues and hand shared CI to trekmeester.

A pre-existing date-formula test fails in Europe/Amsterdam and passes in UTC;
its source is unchanged. Earlier interrupted checks during migration edits are
superseded by the final full passing run.

## Compatibility limits and remaining evidence

Migration retains subjects, user fields and manually moved resources. Ambiguous
historical aliases are reported and block creating competing destinations.
An unresolved old-format source opened directly shows a validated integration
App link before granting a frame or installing schema. An alias outside the
selected frame root is never rewritten using broader drive permissions. Saved
historical compatibility resources are retained rather than deleted.

Local provider/browser tests use invented records and a protocol-checking proxy;
they do not certify a new live GitHub OAuth login. Real account credentials and
existing localhost drive data remain separate from test-only server stores.

Shared CI scheduling belongs to trekmeester under the current feature workflow.
No worker dispatches or reruns shared CI for this refactor. The earlier full
hosted run 44341195612 passed on 43eb0306c; that is not CI evidence for the new
commit. Never merge the server PR from this task. Keep this handoff until exact
final-source CI and review are complete, then remove the completed plan.
