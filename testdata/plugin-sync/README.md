# `plugin-sync` fixture

A frozen, checked-in plugin bundle used as test *input* by the host's sync
tests in `server/src/plugins/sync_session_tests.rs`. The e2e catalog mock
(`testdata/atomic-plugins-mock`) also serves it as the `fixture-api` entry's
bundle, but nothing loads it from there yet. The action, trigger and scheduler
tests use `testdata/plugin-for-testing` instead.

It is not a plugin this repo ships, builds, or maintains. Plugins live in
[atomic-plugins](https://github.com/ontola/atomic-plugins) and reach a server
as JS bundles fetched over HTTP from a catalog. This copy exists only because
the host's sync machinery — pagination, id-mapping, the outbox, crash/restart
resume, fail-closed conflicts — is worth testing against a realistic plugin
rather than a stub, and a test needs a fixture that cannot change underneath
it.

Its operations point at `api.github.com/repos/atomic-fixtures/issues`, which
is not a real repository: every test that uses it mocks the provider.

Do not update this to track its upstream. If the host contract changes such
that this bundle no longer loads, that is the signal to re-freeze it.
