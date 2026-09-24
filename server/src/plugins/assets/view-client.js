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
    settle.reject(new Error(message.error));
  } else {
    settle.resolve(message.result);
  }
});

function send(op, payload) {
  const id = ++nextId;

  return new Promise((resolve, reject) => {
    // A host that never answers would otherwise leave the plugin waiting
    // forever. Allow the host's 30s database-leader / websocket recovery to
    // finish before abandoning a cold-start query after a page reload.
    const timer = setTimeout(() => {
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
function makeResource(subject, propVals) {
  const props = { ...propVals };
  let destroyed = false;

  return {
    subject,
    get props() {
      return { ...props };
    },
    get(property) {
      return props[property];
    },
    set(property, value) {
      props[property] = value;

      return this;
    },
    remove(property) {
      delete props[property];

      return this;
    },
    async save() {
      if (destroyed) throw new Error('This resource was destroyed.');

      await send('save', { subject, propVals: props });

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

  async getResource(subject) {
    const result = await send('get', { subject });

    return makeResource(result.subject, result.props);
  },

  /** Subjects matching a property/value pair, scoped to this drive. */
  async query({ property, value }) {
    return send('query', { property, value });
  },

  /**
   * Creates a resource. `parent` defaults to the app, which is the one place
   * a view may always write.
   */
  async newResource({ parent, isA = [], propVals = {} } = {}) {
    const result = await send('create', { parent, isA, propVals });

    return makeResource(result.subject, result.props);
  },

  /**
   * Calls back whenever `subject` changes, until the returned function runs.
   *
   * Writing from inside the handler can feed itself: adding a child counts as
   * a change to its parent, so a view that subscribes to its app and writes
   * into it on every notification will keep going. Guard on what actually
   * changed, or write somewhere you are not watching.
   */
  subscribe(subject, handler) {
    const listener = event => {
      if (event.source === window.parent && event.data?.type === 'atomic.view.change' && event.data.version === 1 && event.data.subject === subject) handler();
    };

    window.addEventListener('message', listener);
    void send('subscribe', { subject });

    return () => {
      window.removeEventListener('message', listener);
      void send('unsubscribe', { subject });
    };
  },

  /**
   * The integration proxy, reached through the host.
   *
   * This frame never holds a credential: it names a connection by its public
   * reference (`platform` + `connectionId`) and the host page, which holds the
   * connection, makes the call and returns only status, a few headers and the
   * body. A connection is usable only by the app it was made for.
   */
  proxy: {
    /**
     * One provider call. `path` is the provider path (after the proxy's
     * `/proxy/<platform>` prefix); `body`, when given, is JSON text. Resolves
     * to `{ status, headers, body }`, `body` parsed as JSON when it is JSON.
     */
    async request({ platform, connectionId, path, method, query, body, ifMatch }) {
      return send('proxy', { platform, connectionId, path, method, query, body, ifMatch });
    },

    /** This app's connections for `platform` in this browser: `[{ connectionId, platform }]`. */
    async connections({ platform }) {
      return send('proxyConnections', { platform });
    },

    /**
     * Asks the person, in the host's own UI, to connect `platform` for this
     * app. On consent the page navigates to the proxy and back, reloading
     * this view, so the promise only settles when they cancel.
     */
    async connect({ platform }) {
      return send('proxyConnect', { platform });
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
      return send('revokeRouteToken', { tokenId });
    },
  },
};
