# `plugin-for-testing` fixture

A small, hand-written plugin (`plugin.js` + `manifest.json`) that the host's
own tests point at. It is not a real integration and not something this repo
ships: plugins live in [atomic-plugins](https://github.com/ontola/atomic-plugins).
Its provider, `https://provider.test`, does not exist; every test mocks it.

Used by:

- `server/src/plugins/actions.rs`, `triggers.rs` and `scheduler.rs` tests —
  the `action` phase. Its URLs come from `config.collection`, so these tests
  also prove the reviewed config reaches the plugin.
- `server/src/plugins/plugin_for_testing_tests.rs` — the `discover` phase, and
  a `preview`/`step` sync of one field's name in both directions.
- `browser/lib/src/plugin-manifest.test.ts` — validates `manifest.json`.
- `testdata/atomic-plugins-mock` — serves `plugin.js` as the
  `fixture-experimental` catalog entry's bundle.

Unlike `testdata/plugin-sync`, this one is meant to be edited: when a host
test needs another phase, add it here and keep it minimal.
