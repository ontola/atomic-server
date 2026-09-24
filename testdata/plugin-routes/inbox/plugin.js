// Fixture: a version-three plugin whose routes write (AS-07). It needs
// `--plugin-routes read-write`, a route grant for its `inbox-items` write
// target, and `config.inbox` naming the resource items go under. Its
// manifest is `manifest.json` next to this file; the Rust tests load both
// with `include_str!`.
//
// - `POST /inbox` with `{ name, text }` creates a PlainText under the inbox.
// - `GET /items` lists the inbox's items, as the public agent reads them.
// - `PUT /item` with `{ subject, text }` changes an item's description.
// - `DELETE /item` with `{ subject }` destroys an item.
//
// For the tests, a POST may also name `parent` and `class`, and a PUT any
// `subject`: that is how they check the host refuses writes outside the
// write target and changes to resources this installation did not create.
// A real plugin decides these itself.
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const PARENT = 'https://atomicdata.dev/properties/parent';
const PROVENANCE = 'https://atomicdata.dev/properties/routeProvenance';
const PLAIN_TEXT = 'https://atomicdata.dev/classes/PlainText';

function reply(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function handle(ctx, request) {
  const body = JSON.parse(request.body || '{}');
  switch (`${request.method} ${ctx.trigger.route}`) {
    case 'POST inbox':
      return {
        response: reply(202, { accepted: true }),
        intents: [
          {
            op: 'create',
            localId: 'item',
            parent: body.parent || ctx.config.inbox,
            isA: [body.class || PLAIN_TEXT],
            set: { [NAME]: body.name || 'Inbox item', [DESCRIPTION]: body.text || '' },
          },
        ],
      };
    case 'GET items':
      // Read as the public agent: what anyone may see of the inbox.
      return reply(
        200,
        ctx.query(PARENT, ctx.config.inbox).map((subject) => {
          const item = ctx.read(subject);
          return {
            subject,
            name: item[NAME],
            description: item[DESCRIPTION],
            provenance: item[PROVENANCE],
          };
        }),
      );
    case 'PUT item':
      return {
        response: reply(200, { updated: body.subject }),
        intents: [{ op: 'set', subject: body.subject, set: { [DESCRIPTION]: body.text } }],
      };
    case 'DELETE item':
      return {
        response: reply(200, { deleted: body.subject }),
        intents: [{ op: 'destroy', subject: body.subject }],
      };
    default:
      return reply(404, { error: 'not here' });
  }
}

export function run() {
  return { intents: [] };
}
