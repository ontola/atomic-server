// Fixture: an `auth: dpop` route on the `installation-origin` mount, the
// shape of a Solid resource server (atomic-plugins#167, section 3). Its
// manifest is `manifest.json` next to this file; `route_dpop_test.rs` loads
// both with `include_str!`.
//
// - `GET /{*path}` answers with `request.caller` and the headers a Solid
//   server sends (two `Link` lines, `WAC-Allow`, `Allow`, `Accept-Patch`).
// - `PUT /{*path}` stores the body as a PlainText under `config.folder`,
//   named by the path, whoever asks: the host must refuse the write when
//   nobody authenticated. A real plugin decides who may write itself.
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const PLAIN_TEXT = 'https://atomicdata.dev/classes/PlainText';

export function handle(ctx, request) {
  const headers = {
    'content-type': 'application/json',
    link: [
      '<http://www.w3.org/ns/ldp#Resource>; rel="type"',
      '<http://www.w3.org/ns/ldp#RDFSource>; rel="type"',
    ],
    'wac-allow': request.caller ? 'user="read write",public="read"' : 'public="read"',
    allow: 'GET, HEAD, PUT',
    'accept-patch': 'text/n3',
  };
  if (request.method === 'PUT') {
    return {
      response: { status: 201, headers, body: JSON.stringify({ caller: request.caller }) },
      intents: [
        {
          op: 'create',
          localId: 'note',
          parent: ctx.config.folder,
          isA: [PLAIN_TEXT],
          set: { [NAME]: request.params.path, [DESCRIPTION]: request.body || '' },
        },
      ],
    };
  }
  return {
    status: 200,
    headers,
    body: JSON.stringify({ caller: request.caller, url: request.url }),
  };
}
