// Fixture: a minimal Open Cloud Mesh receiver (ontola/atomic-plugins#167,
// OCM 1.5). It needs `--plugin-routes read-write`, a route grant for its
// `received` write target and `config.folder`. Its manifest is
// `manifest.json` next to this file; `route_ocm_test.rs` loads both. Its
// operations are `http://*` so the test can use a plain stub on loopback; a
// real plugin declares `https://*`.
//
// - `GET /ocm/jwks` publishes `ocm-key` as a JWK Set, `kid` `<host>#ocm-key`.
// - `POST /ocm/shares` (`auth: http-signature`; the host verifies the
//   `tag="ocm"` signature with the sender's discovered JWK Set) fetches the
//   share's WebDAV `uri` with its `sharedSecret` into the blob store
//   (`ctx.blobs.fetch`), stores a File holding that blob under
//   `config.folder`, enqueues a signed `SHARE_ACCEPTED` notification to the
//   sender's discovered `endPoint`, and answers `201` with what it saw. The
//   secret is never stored or answered. A fetch that fails is a `400` and
//   nothing is stored or sent.
//
// The real receiver is `integrations/open-cloud-mesh/` in
// ontola/atomic-plugins; this fixture only exercises the host contracts.
const NAME = 'https://atomicdata.dev/properties/name';
const BLOB = 'https://atomicdata.dev/properties/blob';
const FILESIZE = 'https://atomicdata.dev/properties/filesize';
const MIMETYPE = 'https://atomicdata.dev/properties/mimetype';
const DOWNLOAD_URL = 'https://atomicdata.dev/properties/downloadURL';
const FILE = 'https://atomicdata.dev/classes/File';

function reply(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function host(request) {
  return request.base.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

export function handle(ctx, request) {
  switch (`${request.method} ${ctx.trigger.route}`) {
    case 'GET jwks': {
      const key = ctx.keys.publicKey('ocm-key');
      return reply(200, { keys: [{ ...key.jwk, kid: `${host(request)}#ocm-key` }] });
    }
    case 'POST shares': {
      const share = JSON.parse(request.body);
      const dav = share.protocol.webdav;
      let answer;
      try {
        answer = ctx.blobs.fetch({
          operation: 'fetch-file',
          url: dav.uri,
          headers: { authorization: `Bearer ${dav.sharedSecret}` },
        });
      } catch (e) {
        return reply(400, { error: String(e) });
      }
      if (!answer.blob) return reply(400, { status: answer.status });
      return {
        response: reply(201, {
          recipientDisplayName: 'Fixture',
          caller: request.caller,
          blob: answer.blob,
        }),
        intents: [
          {
            op: 'create',
            localId: 'file',
            parent: ctx.config.folder,
            isA: [FILE],
            set: {
              [NAME]: share.name,
              [BLOB]: answer.blob.subject,
              [FILESIZE]: answer.blob.size,
              [MIMETYPE]: answer.blob.type,
              [DOWNLOAD_URL]: `/download/files/${answer.blob.hash}`,
            },
          },
        ],
        enqueue: [
          {
            operation: 'notify',
            url: `${request.caller.endPoint}/notifications`,
            body: {
              notificationType: 'SHARE_ACCEPTED',
              senderDomain: host(request),
              resourceType: 'file',
              notification: { file: { providerId: share.providerId } },
            },
            sign: { key: 'ocm-key', keyId: `${host(request)}#ocm-key`, tag: 'ocm' },
            idempotencyKey: `accepted:${share.providerId}`,
          },
        ],
      };
    }
    default:
      return reply(404, { error: 'not here' });
  }
}

export function run() {
  return { intents: [] };
}
