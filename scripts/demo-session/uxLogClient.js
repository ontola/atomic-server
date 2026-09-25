// In-page half of the dev-only interaction logger (see uxLogPlugin.ts).
// Records what a test user does and what goes wrong, and posts it to the Vite
// dev server, which appends it to a JSONL file the session observer tails.
//
// Logged: clicks (text, role, test id, short selector, and for table cells
// the row and column), committed input values
// (80 characters at most; password fields and anything labelled secret, key,
// token or password are never logged), Enter/Escape, route changes, dialogs
// and toasts appearing, console.error/warn, uncaught errors, failed or slow
// fetches, and WebSocket closes that were not clean.
//
// Also exposes `window.__demoSeed(name)` and runs it once when the page was
// opened with `?demo-seed=<name>` (normally on /app/dev-drive).

const ENDPOINT = '/__ux-log';
const MAX_TEXT = 80;
const SLOW_FETCH_MS = 3000;
const SECRET_HINT = /password|secret|token|api.?key|private/i;
const originalFetch = window.fetch.bind(window);

let queue = [];
let flushTimer;

function now() {
  return new Date().toISOString();
}

function clip(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
}

function log(type, data) {
  queue.push({ t: now(), type, path: location.pathname, ...data });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300);
}

function flush() {
  if (!queue.length) return;
  const body = JSON.stringify(queue);
  queue = [];
  originalFetch(ENDPOINT, {
    method: 'POST',
    body,
    keepalive: true,
    headers: { 'content-type': 'application/json' },
  }).catch(() => undefined);
}

window.addEventListener('pagehide', flush);

// --- Element description -----------------------------------------------------

const INTERACTIVE =
  'button,a,input,select,textarea,label,summary,[role],[data-testid],[contenteditable="true"],[tabindex]';

function shortSelector(el) {
  const parts = [];
  let node = el;

  while (node && node.nodeType === 1 && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    const testId = node.getAttribute('data-testid');
    if (node.id && !/^[:r]/.test(node.id)) part += `#${node.id}`;
    if (testId) part += `[data-testid="${testId}"]`;
    parts.unshift(part);
    if (testId || node.id) break;
    node = node.parentElement;
  }

  return parts.join(' > ');
}

function labelFor(el) {
  return clip(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el.labels && el.labels[0]?.innerText) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '',
  );
}

function isSecretField(el) {
  return (
    el.type === 'password' ||
    SECRET_HINT.test(
      [
        el.name,
        el.id,
        el.getAttribute('autocomplete'),
        el.getAttribute('placeholder'),
        labelFor(el),
      ].join(' '),
    )
  );
}

// A table-editor cell has no text of its own worth logging (often empty, or
// an input); name it by its row's first column and its column header.
function tableCell(el) {
  const cell = el.closest?.('[role="gridcell"],[role="rowheader"]');
  if (!cell) return undefined;
  const row = cell.closest('[role="row"]');
  const grid = cell.closest('[role="grid"]');
  const colIndex = cell.getAttribute('aria-colindex');
  const header =
    colIndex &&
    grid?.querySelector(`[role="columnheader"][aria-colindex="${colIndex}"]`);

  return {
    row:
      clip(row?.querySelector('[aria-colindex="2"]')?.innerText) || undefined,
    column: clip(header?.innerText) || undefined,
    rowIndex: row?.getAttribute('aria-rowindex') ?? undefined,
  };
}

function describe(target) {
  const el = target.closest?.(INTERACTIVE) ?? target;
  const within = el.closest?.('[data-testid]');
  const dialog = el.closest?.('[role="dialog"],dialog');

  return {
    cell: tableCell(el),
    text: isSecretField(el) ? '[redacted]' : clip(el.innerText || el.value),
    label: labelFor(el) || undefined,
    role: el.getAttribute?.('role') || el.tagName?.toLowerCase(),
    testid: el.getAttribute?.('data-testid') || undefined,
    within:
      within && within !== el ? within.getAttribute('data-testid') : undefined,
    dialog: dialog ? clip(dialogTitle(dialog)) || true : undefined,
    date: el.closest?.('[data-date]')?.getAttribute('data-date') || undefined,
    sel: shortSelector(el),
  };
}

function dialogTitle(dialog) {
  const heading = dialog.querySelector('h1,h2,h3,[role="heading"]');

  return (
    dialog.getAttribute('aria-label') ||
    heading?.innerText ||
    dialog.innerText?.slice(0, 40)
  );
}

// --- User actions ------------------------------------------------------------

document.addEventListener(
  'click',
  e => log('click', describe(e.target)),
  true,
);

document.addEventListener(
  'change',
  e => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const secret = isSecretField(el);
    log('input', {
      label: labelFor(el),
      cell: tableCell(el),
      value: secret
        ? '[redacted]'
        : el.type === 'checkbox'
          ? el.checked
          : clip(el.value),
      sel: shortSelector(el),
    });
  },
  true,
);

document.addEventListener(
  'keydown',
  e => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const el = e.target;
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? isSecretField(el)
          ? '[redacted]'
          : clip(el.value)
        : el.isContentEditable
          ? clip(el.innerText)
          : undefined;
    log('key', { key: e.key, value, sel: shortSelector(el) });
  },
  true,
);

// --- Navigation --------------------------------------------------------------

let lastUrl = location.pathname + location.search;

function routeChanged(how) {
  const url = location.pathname + location.search;
  if (url === lastUrl) return;
  log('route', { how, from: lastUrl, to: url });
  lastUrl = url;
}

for (const method of ['pushState', 'replaceState']) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    routeChanged(method);

    return result;
  };
}

window.addEventListener('popstate', () => routeChanged('popstate'));

// --- Dialogs and toasts appearing --------------------------------------------

const seen = new WeakSet();

function isVisible(el) {
  if (el.tagName === 'DIALOG' && !el.open) return false;

  return el.checkVisibility
    ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    : el.offsetParent !== null;
}

new MutationObserver(records => {
  for (const record of records) {
    // A native <dialog> opened in place with showModal().
    if (record.type === 'attributes') {
      const el = record.target;
      if (el.tagName === 'DIALOG' && el.open)
        setTimeout(() => log('dialog', { title: clip(dialogTitle(el)) }), 300);
      continue;
    }

    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      const found = [
        node,
        ...node.querySelectorAll('[role="dialog"],dialog[open],[role="status"],[role="alert"]'),
      ];

      for (const el of found) {
        if (seen.has(el)) continue;
        const role = el.getAttribute('role') || el.tagName.toLowerCase();

        if (role !== 'dialog' && role !== 'status' && role !== 'alert')
          continue;
        // The app keeps some dialogs and live regions mounted but hidden;
        // only log what the user can actually see.
        setTimeout(() => {
          if (seen.has(el) || !isVisible(el)) return;
          seen.add(el);
          if (role === 'dialog') {
            log('dialog', { title: clip(dialogTitle(el)) });
          } else {
            const text = clip(el.innerText);
            if (text) log('toast', { role, text });
          }
        }, 300);
      }
    }
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['open'],
});

// --- Errors ------------------------------------------------------------------

function stringify(arg) {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

for (const level of ['error', 'warn']) {
  const original = console[level];
  console[level] = function (...args) {
    try {
      log(`console-${level}`, {
        message: args.map(stringify).join(' ').slice(0, 500),
      });
    } catch {
      // Never let the logger break the app.
    }

    return original.apply(this, args);
  };
}

window.addEventListener('error', e =>
  log('uncaught', {
    message: String(e.message).slice(0, 500),
    source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
  }),
);

// Scripts, styles and images that fail to load: `error` does not bubble for
// these, so listen in the capture phase.
window.addEventListener(
  'error',
  e => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    log('resource-failed', {
      tag: el.tagName.toLowerCase(),
      url: shortUrl(el.src || el.href || ''),
    });
  },
  true,
);

// Vite's own error overlay (a failed import or transform).
if (import.meta.hot) {
  import.meta.hot.on('vite:error', payload =>
    log('vite-error', {
      message: String(payload?.err?.message ?? '').slice(0, 500),
      file: payload?.err?.id,
    }),
  );
}

window.addEventListener('unhandledrejection', e =>
  log('unhandled-rejection', { message: stringify(e.reason).slice(0, 500) }),
);

// --- Network -----------------------------------------------------------------

function shortUrl(input) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));

  return url.length > 200 ? url.slice(0, 200) + '…' : url;
}

window.fetch = async function (input, init) {
  const started = performance.now();
  const method = (init?.method || input?.method || 'GET').toUpperCase();

  try {
    const response = await originalFetch(input, init);
    const ms = Math.round(performance.now() - started);

    if (!response.ok) {
      let body;
      try {
        body = clip(await response.clone().text());
      } catch {
        body = undefined;
      }
      log('fetch-failed', {
        method,
        url: shortUrl(input),
        status: response.status,
        ms,
        body,
      });
    } else if (ms > SLOW_FETCH_MS) {
      log('fetch-slow', { method, url: shortUrl(input), ms });
    }

    return response;
  } catch (error) {
    if (error?.name !== 'AbortError')
      log('fetch-error', {
        method,
        url: shortUrl(input),
        message: stringify(error),
      });
    throw error;
  }
};

const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener('close', e => {
      if (e.code !== 1000 && e.code !== 1001)
        log('ws-close', { url: shortUrl(args[0]), code: e.code, reason: e.reason });
    });
  }
};

// --- Seeding -----------------------------------------------------------------

async function waitFor(check, what, timeoutMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
}

window.__demoSeed = async name => {
  const store = await waitFor(() => window.store?.getAgent() && window.store, 'a signed-in store');
  const drive = await waitFor(() => store.getDrive(), 'a drive');
  const { seed } = await import('virtual:demo-seed');
  log('seed-start', { name, drive });
  const result = await seed(store, name, drive);
  log('seed-done', { name, ...result });

  return result;
};

// `?demo-seed=<name>` on /app/dev-drive: that route creates an agent and a
// drive, navigates to the drive, and the app may then reload the page. The
// request is kept in sessionStorage so the seed runs once, on whichever page
// load settles on the new drive, and never twice.
const PENDING_KEY = 'demo-session.pending-seed';

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Seeding is a convenience; without storage it just does not run.
  }
}

const requestedSeed = new URLSearchParams(location.search).get('demo-seed');
if (requestedSeed) sessionSet(PENDING_KEY, requestedSeed);

if (sessionGet(PENDING_KEY)) {
  (async () => {
    await waitFor(
      () =>
        !location.pathname.startsWith('/app/dev-drive') &&
        window.store?.getAgent() &&
        window.store.getDrive(),
      'the dev drive',
    );
    // Give a post-sign-in reload the chance to happen first.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const name = sessionGet(PENDING_KEY);
    if (!name) return;
    sessionSet(PENDING_KEY, null);
    const result = await window.__demoSeed(name);
    if (result?.open) location.assign(result.open);
  })().catch(error => log('seed-failed', { message: stringify(error) }));
}

log('page-load', { url: location.pathname + location.search, ua: navigator.userAgent.slice(0, 120) });
