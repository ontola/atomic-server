/**
 * The data API a view gets, and the only one it should need.
 *
 * Shaped after `Store` and `Resource` from `@tomic/lib` on purpose. An author
 * — usually a model that has read the Atomic docs and nothing about this file
 * — should be able to write `store.getResource(...)`, `resource.set(...)`,
 * `resource.save()` and have it work. The postMessage traffic underneath is a
 * transport, not a second vocabulary to learn.
 *
 * Served to the plugin iframe by `/plugin-ui?format=client`. Plain JS with no
 * build step, for the same reason the plugin itself has none.
 */

let nextId = 0;
/** The host refuses larger `getMany` batches; say so before asking. */
const MAX_GET_MANY = 100;
const pending = new Map();

window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.type !== 'atomic.view.response' || message.version !== 1) return;

  if (!message || message.id === undefined) return;

  const settle = pending.get(message.id);

  if (!settle) return;

  pending.delete(message.id);
  clearTimeout(settle.timer);

  if (message.error) {
    const error = new Error(message.error);

    // A failed `call` names why, in the host ABI's codes.
    if (message.code) {
      error.name = 'HostError';
      error.code = message.code;
    }

    settle.reject(error);
  } else {
    settle.resolve(message.result);
  }
});

/** Requests that wait on the person, so they get no timeout. */
const ASKS_THE_PERSON = new Set([
  'confirm',
  'menu',
  'share',
  'pickResource',
  'pickFile',
  'form',
  'proxyConnect',
  'openExternal',
  'runImporter',
  'requestRowAccess',
]);

/** A MouseEvent or `{ x, y }`, as a point in this frame. */
function point(at) {
  if (at && typeof at.clientX === 'number') return { x: at.clientX, y: at.clientY };

  return at;
}

// ---- Theme: whether the host is light or dark ----

/** The last `colorScheme` the host sent, once one has arrived here. */
let colorScheme;
const themeListeners = new Set();

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== '__atomic_style') return;
  const next = event.data.colorScheme;
  if (next !== 'light' && next !== 'dark') return;
  // Compared with what `getTheme()` already said, so the first message after
  // load is not reported as a switch.
  const changed = next !== currentColorScheme();
  colorScheme = next;
  if (changed) for (const listener of themeListeners) listener({ colorScheme });
});

/**
 * The host's scheme. The page shell applies the host's theme before this
 * module runs, so until a message arrives here, read it back from the
 * `color-scheme` the theme stylesheet sets on `:root`.
 */
function currentColorScheme() {
  if (colorScheme) return colorScheme;

  try {
    return getComputedStyle(document.documentElement).colorScheme.split(' ').includes('dark') ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Keys this view did not handle go up to the host, so its shortcuts (search,
 * Escape) still work while focus is in here. Only Escape and keys held with
 * Ctrl, Cmd or Alt: plain typing stays in this frame. A view that handles a
 * key itself calls `preventDefault()` and the host never sees it.
 */
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key !== 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) return;

  window.parent.postMessage(
    {
      type: 'atomic.view.key',
      version: 1,
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    },
    '*',
  );
});

function send(op, payload) {
  const id = ++nextId;

  return new Promise((resolve, reject) => {
    // A host that never answers would otherwise leave the plugin waiting
    // forever. Allow the host's 30s database-leader / websocket recovery to
    // finish before abandoning a cold-start query after a page reload.
    //
    // Not for a question the person answers: they may take as long as they
    // like, and a confirm that rejected while still on screen would be a lie.
    const timer = ASKS_THE_PERSON.has(op)
      ? undefined
      : setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`The host did not answer ${op} in time.`));
          }
        }, 60000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'atomic.view.request', version: 1, id, op, args: payload }, '*');
  });
}

/**
 * A resource, buffered locally.
 *
 * `set` stages; `save` sends. Same shape as `@tomic/lib`, and the same reason:
 * a write per keystroke is a commit per keystroke.
 */
function makeResource(subject, propVals, title = subject) {
  const props = { ...propVals };
  // Set and removed since the last save. `save` sends only these: the rest
  // is what the host already has (re-sending it would also write back
  // whatever the host keeps alongside, and undo a removal). Removals go apart
  // from the values: the host's save only sets, so leaving a property out
  // would keep it.
  const changed = new Set();
  const removed = new Set();
  let destroyed = false;

  return {
    subject,
    title,
    get props() {
      return { ...props };
    },
    get(property) {
      return props[property];
    },
    set(property, value) {
      props[property] = value;
      changed.add(property);
      removed.delete(property);

      return this;
    },
    remove(property) {
      delete props[property];
      changed.delete(property);
      removed.add(property);

      return this;
    },
    getClasses() {
      const isA = props['https://atomicdata.dev/properties/isA'];

      return Array.isArray(isA) ? isA : [];
    },
    hasClasses(...classes) {
      const own = this.getClasses();

      return classes.every(c => own.includes(c));
    },
    async save() {
      if (destroyed) throw new Error('This resource was destroyed.');

      const remove = [...removed];
      const propVals = Object.fromEntries([...changed].map(property => [property, props[property]]));
      await send('save', { subject, propVals, ...(remove.length ? { remove } : {}) });
      for (const property of remove) removed.delete(property);
      for (const property of Object.keys(propVals)) changed.delete(property);

      return this;
    },
    async destroy() {
      await send('destroy', { subject });
      destroyed = true;
    },
  };
}

export const store = {
  /** The app this view belongs to. Its own data lives under here. */
  async getApp() {
    return send('app', {});
  },

  /**
   * The table this app's rows live in, and the class they are.
   *
   * A table rather than a folder, so the same rows are sortable, filterable
   * and editable outside the app without the app implementing any of that.
   * Create rows with this as their parent and class and they show up in both.
   */
  async getData() {
    return send('data', {});
  },

  /**
   * Whether this app may edit the rows of the table it is a view of.
   *
   * Showing an app as a table's view lets it read the rows, not change them.
   * Someone who can edit the table allows that, when they add the app as a
   * view or when the app asks with `requestRowAccess()`. Resolves to
   * `{ status: 'granted', grantedBy, grantedAt, via, extras }`,
   * `{ status: 'none' }`, or `{ status: 'unavailable' }` when the app is not
   * shown as a table's view.
   * With a grant, `resource.save()` on a row of that table may set the
   * table's columns (the row class's properties), and `newResource` may add a
   * row of that class. Deleting rows is never included. `extras` lists the
   * properties the app declared on its App resource as `row-extras` (a sync's
   * provider id, ETag, baseline) that this grant also lets it write on those
   * rows. When the app declares more than the grant covers,
   * `requestRowAccess()` asks the person again.
   */
  async rowAccess() {
    return send('rowAccess', {});
  },

  /**
   * Asks the person, in the host's own UI, to let this app edit the table's
   * rows. Resolves to `{ status: 'granted' }` or `{ status: 'denied', reason }`
   * (they said no, or cannot edit the table themselves).
   */
  async requestRowAccess() {
    return send('requestRowAccess', {});
  },

  async getResource(subject) {
    const result = await send('get', { subject });

    return makeResource(result.subject, result.props, result.title);
  },

  /**
   * Subjects of a collection, like `CollectionBuilder` builds: `property` and
   * `value`, more `filters` (`[{ property, value }]`, at most 10), `sortBy`,
   * `sortDesc`. Every member (at most 500), or one `page` of `pageSize` (up
   * to 100).
   */
  async query(args) {
    return send('query', { ...args });
  },

  /** Full-text search: subjects, optionally of class `isA` or under `parents`. */
  async search(text, { isA, parents, limit } = {}) {
    return send('search', { text, isA, parents, limit });
  },

  /** `{ subject, agent }`: what this view shows, and who is looking. */
  async getContext() {
    return send('context', {});
  },

  /**
   * Reads up to 100 resources in one round trip, with the same rights as
   * `getResource` and seeing this person's own writes the same way.
   * Resolves to an array in the order asked: a resource for each one that
   * could be read, and `{ subject, error }` in the place of one that could
   * not, so one missing row does not fail the rest. More than 100 is
   * refused; ask in batches.
   */
  async getMany(subjects) {
    const list = Array.from(subjects ?? []);

    if (list.length > MAX_GET_MANY) {
      throw new Error(`getMany reads at most ${MAX_GET_MANY} subjects at a time; ask in batches`);
    }

    if (list.length === 0) return [];

    const results = await send('getMany', { subjects: list });

    return results.map(entry =>
      entry.error === undefined ? makeResource(entry.subject, entry.props, entry.title) : { subject: entry.subject, error: entry.error },
    );
  },

  /**
   * Creates a resource. `parent` defaults to the app, which is the one place
   * a view may always write.
   */
  async newResource({ parent, isA = [], propVals = {} } = {}) {
    const result = await send('create', { parent, isA, propVals });

    return makeResource(result.subject, result.props, result.title);
  },

  /**
   * Several writes as one change: `[{ op: 'create', localId, parent, isA, set },
   * { op: 'set', subject, set }, { op: 'remove', subject, properties },
   * { op: 'destroy', subject }]`, the format a plugin's `run()` returns. Refer
   * to something created in the same call as `local:<localId>`. All of it is
   * checked before anything is written, and a failed write rolls back the
   * ones before it. Resolves to `{ subjects }`, the new subjects by `localId`.
   */
  async apply(intents) {
    return send('apply', { intents });
  },

  /**
   * Calls a function another app in this drive exports, as the signed-in
   * person: `store.callExport('atomic:example/counter@1', 'increment', { ... })`.
   * Resolves to the result; rejects with an error whose `code` is the host's
   * (`not-found`, `forbidden`, `invalid-argument`, ...).
   */
  async callExport(iface, fn, args = {}) {
    return send('call', { interface: iface, function: fn, args });
  },

  /** Reverts this view's latest `apply`. False when there is nothing to undo. */
  async undo() {
    return send('undo', {});
  },

  /**
   * Calls back with the fresh resource whenever `subject` changes, until the
   * returned function runs.
   *
   * Writing from inside the handler can feed itself: adding a child counts as
   * a change to its parent, so a view that subscribes to its app and writes
   * into it on every notification will keep going. Guard on what actually
   * changed, or write somewhere you are not watching.
   */
  subscribe(subject, handler) {
    const listener = event => {
      if (event.source === window.parent && event.data?.type === 'atomic.view.change' && event.data.version === 1 && event.data.subject === subject) {
        // Apps written before the resource was passed along ignore it; a
        // failed read (the subject was just destroyed) still notifies them.
        store.getResource(subject).then(handler, () => handler());
      }
    };

    window.addEventListener('message', listener);
    void send('subscribe', { subject });

    return () => {
      window.removeEventListener('message', listener);
      void send('unsubscribe', { subject });
    };
  },

  /**
   * The host's theme, as far as an app needs to branch on it:
   * `{ colorScheme: 'light' | 'dark' }`, from the host's actual setting.
   * Colours themselves are CSS variables on `:root` (`--t-color-bg`,
   * `--t-color-text`, `--t-color-main`, `--t-color-alert`,
   * `--t-color-warning`, `--t-color-success`, ...).
   */
  getTheme() {
    return { colorScheme: currentColorScheme() };
  },

  /**
   * Calls back with `{ colorScheme }` when the person switches the host
   * between light and dark, until the returned function runs.
   */
  onThemeChange(handler) {
    themeListeners.add(handler);

    return () => themeListeners.delete(handler);
  },

  /**
   * Opens an http(s) link in a new tab, after the person confirms it.
   *
   * This frame has no popup rights, so `window.open` and `target="_blank"`
   * do nothing here. The host shows the destination's host in full and asks;
   * resolves to `{ status: 'opened' }` once it opened the link (with no
   * opener and no referrer), or `{ status: 'cancelled' }`. Anything but
   * http(s), or a link with a user name or password in it, is refused.
   */
  async openExternal(url) {
    return send('openExternal', { url: String(url) });
  },

  /**
   * Shows a resource in the host page, leaving this app. Only a resource the
   * person can already read; resolves to `{ status: 'opened', subject }`,
   * and refuses agents, commits, blobs and anything that is not a subject.
   */
  async openResource(subject) {
    return send('openResource', { subject });
  },

  /**
   * This app's own importer: the plugin whose Set up created the table this
   * app is a view of. The host finds it; an app cannot run anyone else's.
   */
  importer: {
    /**
     * Runs the importer on a file and lets the person review what it
     * proposes, in the host's own review. Nothing is written unless they
     * apply it.
     *
     * Pass `file: { name, mediaType, text }` for a file the app already has
     * (`{ name, mediaType, base64 }` when the importer's `accepts` entry for
     * it declares `as: 'base64'`), or nothing to have the host show its own
     * file picker (this frame is
     * sandboxed and cannot hand over a picked `File`). Resolves to
     * `{ status: 'applied', importer, created, updated, destroyed, failed, errors }`,
     * or `{ status: 'cancelled' | 'nothing', importer }`, or
     * `{ status: 'blocked', importer, errors }`. Rejects when this app has no
     * importer (it is not shown as a view of an importer's table).
     */
    async run({ file, importer } = {}) {
      return send('runImporter', {
        ...(file ? { file } : {}),
        ...(importer ? { importer } : {}),
      });
    },
  },

  /**
   * The integration proxy (ontola/atomic-plugins#54).
   *
   * This frame calls the proxy itself, but never holds a credential that
   * works anywhere else. It makes its own Ed25519 key, in memory and
   * non-extractable, when it first needs one. The host page, which holds the
   * user's key, checks that the connection is delegated to this app and signs
   * a capability bound to this frame's key, valid for minutes. Each request
   * then carries the capability and is signed with the frame's key (a version
   * 2 request signature: method, full URL, timestamp and body hash), so a
   * copied capability is useless outside this frame.
   */
  /**
   * Host UI. The page around this frame draws these with its own components,
   * so they look like the rest of Atomic and can reach past this frame's
   * edges. Each names this app to the person, so it is clear who is asking.
   */
  ui: {
    /** Asks a yes/no question in a host dialog. Resolves to true or false. */
    async confirm({ title, body, confirmLabel, danger = false }) {
      return send('confirm', { title, body, confirmLabel, danger });
    },

    /** A short notice in the host's corner. `kind`: success, error or info. */
    async toast(text, { kind = 'info' } = {}) {
      return send('toast', { text, kind });
    },

    /**
     * A menu at `at`, a point in this frame such as the MouseEvent of a
     * right-click. `items` are `{ id, label, disabled }` or 'divider'.
     * Resolves to the chosen item's id, or null when dismissed.
     */
    async menu({ at, items }) {
      return send('menu', { at: point(at), items });
    },

    /**
     * Atomic's own menu for a resource (open, share, delete, and whatever
     * the host adds later), at `at`.
     */
    async resourceMenu(subject, { at }) {
      return send('resourceMenu', { subject, at: point(at) });
    },

    /** Atomic's share dialog for `subject`. Resolves once it is closed. */
    async share(subject) {
      return send('share', { subject });
    },

    /** Opens `subject` in the host, leaving this view. */
    async openResource(subject) {
      return send('openResource', { subject });
    },

    /**
     * Lets the person search for a resource, optionally of class `isA`.
     * Resolves to its subject, or null when cancelled.
     */
    async pickResource({ isA, title } = {}) {
      return send('pickResource', { isA, title });
    },

    /**
     * Lets the person choose a file in the drive or upload one from their
     * device; an upload is stored under this app. `accept` is a list of MIME
     * types. Resolves to the file's subject, or null when cancelled.
     */
    async pickFile({ accept } = {}) {
      return send('pickFile', { accept });
    },

    /**
     * Atomic's own form for a new resource of `class`, with its editors and
     * validation, prefilled from `propVals`. The person saves it, under
     * `parent` (default: this app; it must be under this app). Resolves to the
     * new subject, or null when cancelled.
     */
    async form({ class: classSubject, parent, propVals } = {}) {
      return send('form', { class: classSubject, parent, propVals });
    },

    /** `{ locale, placement }`: the person's language, and 'page' or 'tab'. */
    async environment() {
      return send('environment', {});
    },
  },

  proxy: {
    /**
     * One provider call. `path` is the provider path (after the proxy's
     * `/proxy/<connection>/<platform>` prefix); `body`, when given, is JSON
     * text. Resolves to `{ status, headers, body }`, `body` parsed as JSON
     * when it is JSON.
     */
    async request({ platform, connectionId, path, method = 'GET', query, body, ifMatch }) {
      return proxyRequest({ platform, connectionId, path, method, query, body, ifMatch });
    },

    /** Connections for `platform` delegated to this app: `[{ connectionId, platform }]`. */
    async connections({ platform }) {
      return send('proxyConnections', { platform });
    },

    /**
     * Asks the person, in the host's own UI, to connect `platform` for this
     * app. If they pick a connection they already have, resolves to
     * `{ status: 'connected', connectionId, platform }`; if they connect a new
     * one, the page goes to the proxy and back, reloading this view, so the
     * promise does not settle; if they cancel, `{ status: 'cancelled' }`.
     */
    async connect({ platform }) {
      return send('proxyConnect', { platform });
    },

    /**
     * Stops this app using `platform`: takes this app's delegation off its
     * connections at the proxy (and, for an Installation, forgets the
     * recorded one). The connection itself stays, since other apps may use
     * it; deleting it is up to the person, on a page. Resolves to
     * `{ status: 'disconnected', platform, connectionIds }`.
     */
    async disconnect({ platform }) {
      const result = await send('proxyDisconnect', { platform });

      for (const key of [...capabilities.keys()]) {
        if (JSON.parse(key)[0] === platform) capabilities.delete(key);
      }

      return result;
    },
  },

  /**
   * This app's public endpoints (plugin routes), for the person viewing it
   * when they may edit the app. The view never calls a route itself.
   */
  routes: {
    /**
     * `readRouteStatus`: `{ state, degraded, refusal, level, mount, routes,
     * deliveries }`. Per route its `url`, `methods`, `auth`,
     * `requests24h`, `errors24h`, `lastError`, `queueDepth` and
     * `oldestQueueFailure`; `deliveries` has the queue's counts, today's
     * use of the daily cap and the last failures. `null` when the server
     * has no plugin routes.
     */
    async status() {
      return send('readRouteStatus', {});
    },

    /** The tokens this app's routes issued: `{ tokens: [{ id, name, scopes, ... }] }`, never their values. */
    async tokens() {
      return send('routeTokens', {});
    },

    /** Revokes one issued token. Resolves to `{ revoked }`. */
    async revokeToken(tokenId) {
      if (typeof tokenId !== 'string' || tokenId === '') throw new Error('revokeToken takes a token id');

      return send('revokeRouteToken', { tokenId });
    },
  },
};

// ---- Integration proxy: frame key, capabilities, signed requests ----

const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PROXY_HEADERS = ['link', 'retry-after', 'etag', 'content-type'];
/** Mint a new capability this long before the current one expires. */
const CAPABILITY_MARGIN_MS = 60_000;

let frameKey;
const capabilities = new Map();

const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

/**
 * This frame's key: made once, kept only in this frame's memory, and never
 * exportable. Where WebCrypto has no Ed25519 (older Safari and Android
 * WebViews, atomic-server#1688) this fails with a clear message instead of
 * falling back to a key script could read.
 */
function getFrameKey() {
  frameKey ??= (async () => {
    if (!globalThis.crypto?.subtle) {
      throw new Error('This browser has no WebCrypto here, so this view cannot sign integration requests.');
    }

    let pair;

    try {
      pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    } catch (e) {
      throw new Error(`This browser cannot make an Ed25519 key (WebCrypto Ed25519 is missing, see atomic-server#1688), so this view cannot reach integrations: ${e?.message ?? e}`);
    }

    const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));

    return { privateKey: pair.privateKey, publicKey, agent: `atomic:agent:${publicKey}` };
  })();
  frameKey.catch(() => {
    frameKey = undefined;
  });

  return frameKey;
}

async function capabilityFor(platform, connectionId, fresh) {
  const key = JSON.stringify([platform, connectionId]);
  const cached = capabilities.get(key);

  if (!fresh && cached && cached.exp * 1000 - Date.now() > CAPABILITY_MARGIN_MS) return cached;

  const { publicKey } = await getFrameKey();
  const minted = await send('proxyCapability', { platform, connectionId, publicKey });

  if (!minted || typeof minted.capability !== 'string' || typeof minted.aud !== 'string') {
    throw new Error('The host returned no capability.');
  }

  capabilities.set(key, minted);

  return minted;
}

/** Version 2 request signature headers, signed with this frame's key. */
async function signV2(method, url, body) {
  const { privateKey, publicKey, agent } = await getFrameKey();
  const timestamp = Date.now();
  const bytes = new TextEncoder().encode(body ?? '');
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  const message = ['atomic-request-v2', method, url, String(timestamp), digest].join('\n');
  const signature = b64url(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(message)));

  return {
    'x-atomic-agent': agent,
    'x-atomic-public-key': publicKey,
    'x-atomic-timestamp': String(timestamp),
    'x-atomic-signature': signature,
    'x-atomic-signature-version': '2',
  };
}

function proxyTarget(aud, connectionId, platform, path, query) {
  if (typeof platform !== 'string' || !/^[a-z0-9-]{1,80}$/.test(platform)) throw new Error('Invalid platform');
  if (typeof connectionId !== 'string' || !connectionId) throw new Error('connectionId is required');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path) || path.length > 4096) {
    throw new Error('Invalid proxy path');
  }

  const prefix = `/proxy/${encodeURIComponent(connectionId)}/${platform}/`;
  const url = new URL(`${prefix.slice(0, -1)}${path}`, aud);

  if (url.origin !== new URL(aud).origin || !url.pathname.startsWith(prefix)) throw new Error('Invalid proxy path');

  for (const [k, v] of Object.entries(query ?? {})) {
    if (typeof v !== 'string') throw new Error('Invalid proxy query');
    url.searchParams.set(k, v);
  }

  return url;
}

function parseBody(text) {
  if (text === '') return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function proxyRequest({ platform, connectionId, path, method, query, body, ifMatch }) {
  const verb = String(method).toUpperCase();
  if (!PROXY_METHODS.includes(verb)) throw new Error('Invalid proxy method');
  if (body !== undefined && typeof body !== 'string') throw new Error('A proxy request body is JSON text');
  if (body !== undefined && verb === 'GET') throw new Error('A GET proxy request has no body');
  if (ifMatch !== undefined && typeof ifMatch !== 'string') throw new Error('Invalid If-Match');

  const attempt = async fresh => {
    const cap = await capabilityFor(platform, connectionId, fresh);
    const url = proxyTarget(cap.aud, connectionId, platform, path, query).href;
    const headers = {
      Authorization: `Capability ${cap.capability}`,
      ...(await signV2(verb, url, body)),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    };

    // The frame has no network (CSP `connect-src 'none'`): the host sends the
    // request we signed, to the proxy only, and hands back the raw response.
    return send('proxyFetch', { url, method: verb, headers, body });
  };

  let response = await attempt(false);
  let parsed = parseBody(response.text);

  // The capability ran out between minting and use (a laptop lid, a slow
  // tab): mint a new one once. Any other refusal is the answer.
  if (response.status === 401 && parsed?.error === 'capability_expired') {
    response = await attempt(true);
    parsed = parseBody(response.text);
  }

  const headers = {};

  for (const name of PROXY_HEADERS) {
    const value = response.headers?.[name];
    if (typeof value === 'string') headers[name] = value;
  }

  return { status: response.status, headers, body: parsed };
}
