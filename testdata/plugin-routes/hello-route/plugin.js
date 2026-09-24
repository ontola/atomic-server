// Fixture: the smallest version-three plugin with a public route, an
// anonymous `GET /hello/{name}` on the `drive-prefix` mount
// (`/_routes/<installation-slug>/hello/<name>`). It needs
// `--plugin-routes read-only`. Its manifest is `manifest.json` next to this
// file; the Rust tests load both with `include_str!`.
//
// Until route execution exists (AS-05, ontola/atomic-server#1715), a matched
// route answers 501 and this source only has to load. #1715 gives it an
// `http` handler that answers `Hello, <name>` and asserts on the body.
export function run() {
  return { intents: [] };
}
