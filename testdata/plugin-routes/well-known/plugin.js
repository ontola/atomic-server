// Fixture: a version-three plugin on the `drive-host` mount that claims two
// `/.well-known/` names on its drive's hosts: `nodeinfo` (exclusive) and
// `webfinger` (shared, for `acct:` resources). It needs
// `--plugin-routes read-only`. Its manifest is `manifest.json` next to this
// file; the Rust tests load both with `include_str!`.
//
// A claimed name runs the route the claim names, with `request.wellKnown`
// set to the name and `request.path` the `/.well-known/` path. The same
// routes also answer on their own paths (`/nodeinfo`, `/nodeinfo/2.1`,
// `/webfinger`) on the drive's hosts.
const NODEINFO_SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';

function json(body, type = 'application/json') {
  return {
    status: 200,
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  };
}

export function handle(ctx, request) {
  switch (ctx.trigger.route) {
    case 'nodeinfo-links':
      return json({ links: [{ rel: NODEINFO_SCHEMA, href: '/nodeinfo/2.1' }] });
    case 'nodeinfo':
      return json(
        {
          version: '2.1',
          software: { name: 'well-known-fixture', version: '0.1.0' },
          protocols: [],
          services: { inbound: [], outbound: [] },
          openRegistrations: false,
          usage: { users: {} },
          metadata: { wellKnown: request.wellKnown },
        },
        `application/json; profile="${NODEINFO_SCHEMA}#"`,
      );
    case 'webfinger':
      return json(
        { subject: request.query.resource, aliases: [], links: [] },
        'application/jrd+json',
      );
    default:
      return { status: 404 };
  }
}

export function run() {
  return { intents: [] };
}
