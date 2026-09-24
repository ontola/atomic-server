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
//
// Host crypto (AS-08, #1718): the `actor-key` and the `storage` tokens.
//
// - `GET /actor` publishes the key's public half, with keyId
//   `<base>/actor#main-key`.
// - `POST /signed-inbox` (`auth: http-signature`) stores an item like
//   `/inbox`, and answers with the verified `request.caller`.
// - `POST /outbox` with `{ to, activity }` has the host sign a delivery to
//   `to` and answers with the signed headers. Only a fixture hands out
//   signatures: a real plugin enqueues the delivery (AS-09).
// - `GET /storage/{*rest}` (`auth: bearer`) answers with the caller.
// - `GET /oauth?scope&client_id&state` redirects to the host's consent page;
//   `GET /oauth/callback` redeems the code it sends back for a token.
// - `POST /tokens` with `{ op: issue | verify | revoke, ... }` calls
//   `ctx.tokens.*` directly.
// - `GET /dump` answers with everything the handler can see, for the test
//   that no key material reaches the sandbox.
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
    case 'GET actor': {
      const id = `${request.base}/actor`;
      const keyId = `${id}#main-key`;
      const key = ctx.keys.publicKey('actor-key', { keyId });
      return reply(200, {
        id,
        type: 'Service',
        publicKey: { id: keyId, owner: id, publicKeyPem: key.publicKeyPem },
      });
    }
    case 'POST signed-inbox':
      return {
        response: reply(202, { caller: request.caller }),
        intents: [
          {
            op: 'create',
            localId: 'item',
            parent: ctx.config.inbox,
            isA: [PLAIN_TEXT],
            set: {
              [NAME]: body.name || 'Signed item',
              [DESCRIPTION]: `from ${request.caller.owner}`,
            },
          },
        ],
      };
    case 'POST outbox':
      return reply(
        200,
        ctx.keys.sign({
          key: 'actor-key',
          keyId: `${request.base}/actor#main-key`,
          operation: 'deliver',
          request: { method: 'POST', url: body.to, body: body.activity },
        }),
      );
    case 'GET storage':
      return reply(200, { caller: request.caller, path: request.params.rest });
    case 'GET oauth': {
      const { url } = ctx.tokens.requestConsent({
        name: 'storage',
        scopes: [request.query.scope],
        client: request.query.client_id,
        redirect: '/oauth/callback',
        state: request.query.state,
      });
      return { status: 302, headers: { location: url } };
    }
    case 'GET oauth-callback':
      if (request.query.error) {
        return reply(403, { error: request.query.error, state: request.query.state });
      }
      return reply(200, {
        ...ctx.tokens.issue({ code: request.query.code }),
        state: request.query.state,
      });
    case 'POST tokens':
      switch (body.op) {
        case 'issue':
          return reply(
            200,
            ctx.tokens.issue({
              name: body.name || 'storage',
              scopes: body.scopes,
              client: body.client,
              expiresIn: body.expiresIn,
            }),
          );
        case 'verify':
          return reply(200, { token: ctx.tokens.verify(body.token) });
        case 'revoke':
          return reply(200, { revoked: ctx.tokens.revoke(body.id) });
        default:
          return reply(400, { error: 'op' });
      }
    case 'GET dump': {
      const attempt = (f) => {
        try {
          return f();
        } catch (e) {
          return { error: String(e) };
        }
      };
      return reply(200, {
        ctx: JSON.stringify(ctx),
        request,
        globals: Object.keys(globalThis),
        publicKey: attempt(() => ctx.keys.publicKey('actor-key')),
        signed: attempt(() =>
          ctx.keys.sign({
            key: 'actor-key',
            keyId: 'https://elsewhere.example/k',
            operation: 'deliver',
            request: { method: 'POST', url: 'https://elsewhere.example/inbox', body: '{}' },
          }),
        ),
        undeclared: attempt(() => ctx.keys.publicKey('other-key')),
        exported: attempt(() => __hostCall('keys.export', JSON.stringify({ key: 'actor-key' }))),
      });
    }
    default:
      return reply(404, { error: 'not here' });
  }
}

export function run() {
  return { intents: [] };
}
