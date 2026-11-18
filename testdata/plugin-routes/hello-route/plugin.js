// Fixture: the smallest version-three plugin with a public route, an
// anonymous `GET /hello/{name}` on the `drive-prefix` mount
// (`/_routes/<installation-slug>/hello/<name>`). It needs
// `--plugin-routes read-only`. Its manifest is `manifest.json` next to this
// file; the Rust tests load both with `include_str!`.
//
// A route request runs `handle(ctx, request)` (the `http` trigger); `run`
// is what every other trigger calls.
export function handle(ctx, request) {
  return {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: `Hello, ${request.params.name}`,
  };
}

export function run() {
  return { intents: [] };
}
