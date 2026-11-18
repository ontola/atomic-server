// Fixture: a remoteStorage-like plugin with blob request and response bodies
// (#1720). It needs `--plugin-routes read-write`, a route grant for its
// `files` write target, and `config.folder` naming the resource files go
// under. Its manifest is `manifest.json` next to this file; the Rust tests
// load both with `include_str!`.
//
// - `PUT /files/{*path}` (`body: blob`): the host has already stored the
//   body; the handler gets `request.blob = { hash, size, type, subject }`
//   and never the bytes. It creates a File named `path` under the folder, or
//   points the existing one at the new blob. It tells the host which blob
//   the path held before (`current`), so the host can answer `If-Match` /
//   `If-None-Match` before anything is stored. It answers with what it saw.
// - `GET|HEAD /files/{*path}` answers with the File's blob. The host
//   streams the bytes and sets `ETag`, and answers conditional requests.
// - `PUT /small/{*path}`: the same as `/files`, with `maxBodyBytes: 1024`.
// - `GET /raw/{hash}?type=` answers with any blob hash it is asked for, so
//   the tests can check the host refuses one this installation may not
//   serve, and the content type rules.
// - `POST /link/{*path}` with `{ hash }` creates a File pointing at `hash`,
//   so the tests can check a route cannot adopt a blob it did not store.
const NAME = 'https://atomicdata.dev/properties/name';
const PARENT = 'https://atomicdata.dev/properties/parent';
const BLOB = 'https://atomicdata.dev/properties/blob';
const FILESIZE = 'https://atomicdata.dev/properties/filesize';
const MIMETYPE = 'https://atomicdata.dev/properties/mimetype';
const DOWNLOAD_URL = 'https://atomicdata.dev/properties/downloadURL';
const FILE = 'https://atomicdata.dev/classes/File';

function find(ctx, path) {
  for (const subject of ctx.query(PARENT, ctx.config.folder)) {
    const item = ctx.read(subject);
    if (item[NAME] === path) return { subject, item };
  }
  return null;
}

function json(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function handle(ctx, request) {
  const path = request.params.path;
  switch (ctx.trigger.route) {
    case 'put':
    case 'small': {
      const existing = find(ctx, path);
      const blob = request.blob;
      const set = {
        [BLOB]: blob.subject,
        [FILESIZE]: blob.size,
        [MIMETYPE]: blob.type,
        [DOWNLOAD_URL]: `${request.base}/files/${path}`,
      };
      return {
        response: {
          ...json(existing ? 200 : 201, { blob, inline: request.body ?? null }),
          current: existing ? existing.item[BLOB] : null,
        },
        intents: existing
          ? [{ op: 'set', subject: existing.subject, set }]
          : [
              {
                op: 'create',
                localId: 'file',
                parent: ctx.config.folder,
                isA: [FILE],
                set: { [NAME]: path, ...set },
              },
            ],
      };
    }
    case 'get': {
      const found = find(ctx, path);
      if (!found) return json(404, { error: 'not found' });
      return {
        response: {
          headers: { 'content-type': found.item[MIMETYPE], 'cache-control': 'no-cache' },
          blob: found.item[BLOB],
        },
      };
    }
    case 'raw':
      return {
        response: {
          headers: request.query.type ? { 'content-type': request.query.type } : {},
          blob: request.params.hash,
        },
      };
    case 'link': {
      const body = JSON.parse(request.body || '{}');
      return {
        response: { status: 201 },
        intents: [
          {
            op: 'create',
            localId: 'file',
            parent: ctx.config.folder,
            isA: [FILE],
            set: {
              [NAME]: path,
              [BLOB]: `atomic:blob:${body.hash}`,
              [DOWNLOAD_URL]: `${request.base}/files/${path}`,
            },
          },
        ],
      };
    }
    default:
      return json(404, { error: 'no such route' });
  }
}
