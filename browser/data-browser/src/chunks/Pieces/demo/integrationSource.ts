// @wc-ignore-file

export interface IntegrationTerms {
  /** Display name of the platform, e.g. "Clockify". */
  provider: string;
  /** The fixture account the demo connects to. */
  account: string;
  /** The provider-shaped properties (what syncables would produce). */
  description: string;
  start: string;
  end: string;
  billable: string;
  /** Sync binding vocabulary. */
  bindingClass: string;
  syncedTable: string;
  syncState: string;
  name: string;
}

/**
 * The integration of the demo. Its "view" is the table's sync state, never
 * the rows: connected account, last sync, the outbox (pending, held, failed,
 * uncertain, blocked) with conflicts, and retry / approve / discard.
 *
 * It only knows its provider-shaped row class. When it is installed on a
 * table of another class, the host hands it the lens chain (`getData()`'s
 * `lensPath`) and it reads every row through that chain. The external
 * platform is a fixture inside this module: nothing leaves the browser.
 *
 * The outbox mirrors syncables' `OutboxDocument` (atomic-plugins#312, #313,
 * #324), simplified: states `pending | held | failed | uncertain | blocked`,
 * failure classes, field-level conflicts `{ field, base, remote, local }`.
 * `held` is the issue-tracker's "review before sending".
 */
export function integrationSource(terms: IntegrationTerms): string {
  return `// ${terms.provider} (demo): an integration. Shows sync state; renders no rows.
const T = ${JSON.stringify(terms)};
const PARENT = 'https://atomicdata.dev/properties/parent';
const LABELS = { [T.description]: 'description', [T.start]: 'start', [T.end]: 'end', [T.billable]: 'billable' };

// --- Lens interpreter (the same format as chunks/Pieces/lens.ts). ---------
const CONVERTERS = {
  identity: { get: v => v, put: v => v },
  'ms-to-iso': {
    get: v => (typeof v === 'number' ? new Date(v).toISOString() : v),
    put: v => (typeof v === 'string' ? Date.parse(v) : v),
  },
};
function lensGet(mapping, row, direction) {
  const out = {};
  for (const f of mapping.fields) {
    const c = CONVERTERS[f.convert || 'identity'];
    const [from, to, get] = direction === 'forward' ? [f.source, f.target, c.get] : [f.target, f.source, c.put];
    if (row[from] !== undefined) out[to] = get(row[from]);
  }
  return out;
}
const along = (path, row) => path.reduce((r, step) => lensGet(step.mapping, r, step.direction), row);
const back = (path, view) => [...path].reverse().reduce((r, step) => lensGet(step.mapping, r, step.direction === 'forward' ? 'backward' : 'forward'), view);

// --- The fixture platform. No network: a few rules standing in for the provider.
const fixturePlatform = {
  account: { id: 'ws-demo', label: T.account },
  send(write) {
    if (!write.payload[T.end]) {
      return { ok: false, status: 400, class: 'permanent', error: T.provider + ' refuses an entry without an end time. Stop the timer, then retry.' };
    }
    return { ok: true, id: write.remoteId || 'ce_' + Math.random().toString(36).slice(2, 8) };
  },
};

const css = \`
  body { font-family: var(--t-font-family, system-ui, sans-serif); color: var(--t-color-text, #1b1b1f); background: var(--t-color-bg, #fff); margin: 0; }
  .wrap { padding: 1rem 1.25rem; max-width: 60rem; }
  h2 { font-size: 1.05rem; margin: 0; display: flex; gap: .5rem; align-items: center; }
  .sub { color: var(--t-color-text-light, #666); font-size: .85rem; margin: .25rem 0 1rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; margin-bottom: 1rem; }
  .card { border: 1px solid var(--t-color-bg2, #e6e6ea); border-radius: 8px; padding: .6rem .75rem; }
  .card .k { font-size: .75rem; color: var(--t-color-text-light, #777); text-transform: uppercase; letter-spacing: .03em; }
  .card .v { font-size: .95rem; margin-top: .2rem; overflow-wrap: anywhere; }
  .lens { font-size: .85rem; background: #f3f0ff; color: #4a3aa8; border-radius: 6px; padding: .45rem .65rem; margin-bottom: 1rem; }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  button { font: inherit; font-size: .85rem; padding: .3rem .7rem; border-radius: 6px; border: 1px solid var(--t-color-bg2, #d0d0d8); background: var(--t-color-bg, #fff); color: inherit; cursor: pointer; }
  button.primary { background: var(--t-color-main, #1a5fd1); border-color: transparent; color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; table-layout: fixed; }
  col.c-row { width: 22%; } col.c-state { width: 26%; } col.c-actions { width: 11rem; }
  th, td { text-align: left; padding: .45rem .5rem; border-top: 1px solid var(--t-color-bg2, #eee); vertical-align: top; }
  th { font-size: .75rem; color: var(--t-color-text-light, #777); font-weight: 600; border-top: none; }
  code { font-size: .78rem; white-space: pre-wrap; word-break: break-word; }
  .state { font-size: .75rem; padding: .1rem .45rem; border-radius: 99px; white-space: nowrap; }
  .pending { background: #e8f0fe; color: #1a4fa8; } .held { background: #fff4d6; color: #7a5a00; }
  .failed { background: #fde8e8; color: #a11d1d; } .uncertain { background: #f1e8fd; color: #5b2aa8; }
  .blocked { background: #eee; color: #444; } .conflict { background: #ffe9d6; color: #8a3f00; } .synced { background: #e7f5ec; color: #19693a; }
  .err { color: #a11d1d; font-size: .8rem; margin-top: .25rem; }
  .actions { display: flex; gap: .35rem; flex-wrap: wrap; }
  .empty { color: var(--t-color-text-light, #777); font-size: .9rem; padding: .75rem 0; }
  @media (max-width: 600px) { .hide-sm { display: none; } col.c-actions { width: 7rem; } }
\`;

function fresh(lensPath) {
  return { account: null, lastSync: null, installedThrough: lensPath.map(l => l.subject), remote: {}, writes: [], discarded: {} };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function view({ root, store }) {
  const { table, rowClass, lensPath = [], pendingReview = [] } = await store.getData();
  const app = await store.getApp();
  const style = document.createElement('style');
  style.textContent = css;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.append(style, wrap);

  // Reachable only through a lens nobody has reviewed: sync nothing, and say
  // which lens is in the way.
  if (pendingReview.length) {
    const style0 = document.createElement('div');
    style0.className = 'wrap';
    style0.innerHTML = '<h2></h2><div class="lens"></div>';
    style0.children[0].textContent = T.provider + ' sync';
    style0.children[1].textContent = 'Waiting for review of ' + pendingReview.join(', ') + '. Until a drive-local lens is approved, nothing on this table is translated or sent.';
    wrap.replaceWith(style0);
    return;
  }

  // The binding: this integration on this table. Several integrations can
  // sync one table; each keeps its own binding under its own app. It lives under the app,
  // which is where an app may always write.
  const existing = (await store.query({ property: T.syncedTable, value: table })) || [];
  let binding;
  for (const s of existing) {
    const r = await store.getResource(s);
    if (r.get(PARENT) === app) { binding = r; break; }
  }
  if (!binding) {
    binding = await store.newResource({
      parent: app,
      isA: [T.bindingClass],
      propVals: { [T.name]: T.provider + ' sync', [T.syncedTable]: table, [T.syncState]: fresh(lensPath) },
    });
  }
  let state = binding.get(T.syncState) || fresh(lensPath);

  async function save() {
    binding.set(T.syncState, state);
    await binding.save();
    await render();
  }

  async function rows() {
    const subjects = await store.query({ property: PARENT, value: table });
    const out = [];
    for (const s of subjects) {
      const r = await store.getResource(s);
      // A table's children include its saved views; only rows are synced.
      if (!r.getClasses().includes(rowClass)) continue;
      out.push({ subject: s, title: r.title, props: r.props, payload: along(lensPath, r.props) });
    }
    return out;
  }

  function sendPending() {
    // A write in conflict waits for the person, whatever its state says.
    for (const w of state.writes.filter(w => w.state === 'pending' && !w.conflicts)) {
      w.attempts = (w.attempts || 0) + 1;
      const res = fixturePlatform.send(w);
      if (res.ok) {
        state.remote[w.row] = { id: res.id, payload: w.payload };
        w.state = 'done';
      } else {
        w.state = res.class === 'auth' ? 'blocked' : 'failed';
        w.lastStatus = res.status;
        w.lastError = res.error;
      }
    }
    state.writes = state.writes.filter(w => w.state !== 'done');
  }

  async function syncNow() {
    for (const row of await rows()) {
      if (state.discarded[row.subject]) continue;
      const remote = state.remote[row.subject];
      const write = state.writes.find(w => w.row === row.subject);
      if (remote && same(remote.payload, row.payload)) {
        state.writes = state.writes.filter(w => w !== write);
        continue;
      }
      if (write) {
        if (!write.conflicts) write.payload = row.payload;
        if (write.state === 'failed') continue; // waits for Retry
        continue;
      }
      state.writes.push({
        row: row.subject,
        title: row.title,
        type: remote ? 'update' : 'create',
        remoteId: remote?.id,
        // New entries are held for review, as the issue tracker does; edits to
        // entries that already exist go straight to the queue.
        state: remote ? 'pending' : 'held',
        payload: row.payload,
        attempts: 0,
      });
    }
    sendPending();
    state.lastSync = Date.now();
    await save();
  }

  async function act(write, action) {
    if (action === 'approve' || action === 'retry') write.state = 'pending';
    if (action === 'discard') {
      state.discarded[write.row] = true;
      state.writes = state.writes.filter(w => w !== write);
    }
    if (action === 'keep-local') {
      write.conflicts = undefined;
      write.state = 'pending';
    }
    if (action === 'take-remote') {
      const remoteView = { ...write.payload };
      for (const c of write.conflicts) remoteView[c.field] = c.remote;
      const writeBack = back(lensPath, remoteView);
      try {
        const row = await store.getResource(write.row);
        for (const [p, v] of Object.entries(writeBack)) row.set(p, v);
        await row.save();
        write.conflicts = undefined;
        state.remote[write.row] = { id: write.remoteId, payload: remoteView };
        state.writes = state.writes.filter(w => w !== write);
      } catch (e) {
        await store.ui.toast('Taking the remote value means writing this table, which needs a row grant (#1788). It would write: ' + JSON.stringify(writeBack), { kind: 'error' });
        return;
      }
    }
    if (action === 'approve' || action === 'retry' || action === 'keep-local') sendPending();
    await save();
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') e.onclick = v; else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  const fmtPayload = p => Object.entries(p).map(([k, v]) => (LABELS[k] || k) + ': ' + JSON.stringify(v)).join('\\n');

  async function render() {
    wrap.textContent = '';
    const synced = Object.keys(state.remote).filter(r => !state.writes.some(w => w.row === r)).length;
    wrap.append(
      el('h2', {}, T.provider + ' sync'),
      el('div', { class: 'sub' }, 'An integration: it syncs this table with ' + T.provider + ' and shows the sync state here. The rows stay in the other tabs.'),
    );
    if (lensPath.length) {
      wrap.append(el('div', { class: 'lens' }, 'This table is not ' + T.provider + '-shaped. Rows are translated through ' + lensPath.map(l => l.name).join(' → ') + '.'));
    }
    const card = (k, v) => el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
    const counts = s => state.writes.filter(w => (s === 'conflict' ? !!w.conflicts : w.state === s && !w.conflicts)).length;
    wrap.append(el('div', { class: 'cards' },
      card('Account', state.account ? state.account.label : 'Not connected'),
      card('Last sync', state.lastSync ? new Date(state.lastSync).toLocaleString() : 'Never'),
      card('In sync', String(synced)),
      card('Outbox', ['held', 'pending', 'failed', 'conflict'].map(s => counts(s) + ' ' + s).join(' · ')),
    ));

    const bar = el('div', { class: 'bar' });
    if (!state.account) {
      bar.append(el('button', { class: 'primary', onclick: async () => { state.account = fixturePlatform.account; await save(); } }, 'Connect ' + T.provider + ' (fixture account)'));
    } else {
      bar.append(el('button', { class: 'primary', onclick: syncNow }, 'Sync now'));
      if (counts('held')) bar.append(el('button', { onclick: async () => { for (const w of state.writes) if (w.state === 'held') w.state = 'pending'; sendPending(); await save(); } }, 'Approve all held'));
      bar.append(el('button', { onclick: async () => { state.account = null; await save(); } }, 'Disconnect'));
    }
    wrap.append(bar);

    if (!state.writes.length) {
      wrap.append(el('div', { class: 'empty' }, state.account ? 'Nothing waiting. Every row is in sync.' : 'Connect an account to start syncing.'));
      return;
    }

    const cols = el('colgroup', {}, el('col', { class: 'c-row' }), el('col', { class: 'c-state' }), el('col', { class: 'hide-sm' }), el('col', { class: 'c-actions' }));
    const t = el('table', {}, cols, el('tr', {}, el('th', {}, 'Row'), el('th', {}, 'State'), el('th', { class: 'hide-sm' }, 'Sent to ' + T.provider + ' as'), el('th', {}, '')));
    for (const w of state.writes) {
      const label = w.conflicts ? 'conflict' : w.state;
      const stateCell = el('td', {}, el('span', { class: 'state ' + label }, label + (w.type === 'create' ? ' · create' : ' · update')));
      if (w.lastError) stateCell.append(el('div', { class: 'err' }, (w.lastStatus ? w.lastStatus + ': ' : '') + w.lastError));
      if (w.conflicts) for (const c of w.conflicts) stateCell.append(el('div', { class: 'err' }, (LABELS[c.field] || c.field) + ': was ' + JSON.stringify(c.base) + ', ' + T.provider + ' has ' + JSON.stringify(c.remote) + ', here ' + JSON.stringify(c.local)));
      const actions = el('div', { class: 'actions' });
      const btn = (text, a) => actions.append(el('button', { onclick: () => act(w, a) }, text));
      if (w.conflicts) { btn('Keep this table\\'s', 'keep-local'); btn('Take ' + T.provider + '\\'s', 'take-remote'); }
      else if (w.state === 'held') btn('Approve', 'approve');
      else if (w.state === 'failed' || w.state === 'uncertain') btn('Retry', 'retry');
      btn('Discard', 'discard');
      t.append(el('tr', {}, el('td', {}, w.title || w.row), stateCell, el('td', { class: 'hide-sm' }, el('code', {}, fmtPayload(w.payload))), el('td', {}, actions)));
    }
    wrap.append(t);
  }

  await render();
}
`;
}
