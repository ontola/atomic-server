// @wc-ignore-file
/*
 * Atomic Server's built-in Syncables view. This file is shipped with the
 * server, never supplied by a provider. It runs inside the existing CSP-
 * sandboxed, null-origin iframe with no direct network access.
 *
 * The ordinary view-client handles signed proxy reads. Privileged resource
 * provisioning goes through syncables* host operations that validate scope.
 */
const pending = new Map();
let serial = 0;

window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.type !== 'atomic.view.response' || message.version !== 1) return;
  if (typeof message.id !== 'string' || !message.id.startsWith('syncables:')) return;
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  clearTimeout(waiting.timer);
  if (message.error) waiting.reject(new Error(message.error));
  else waiting.resolve(message.result);
});

function call(op, args = {}) {
  const id = 'syncables:' + ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Atomic Server did not answer ' + op));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({
      type: 'atomic.view.request',
      version: 1,
      id,
      op,
      args,
    }, '*');
  });
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function button(text, handler, secondary = false) {
  const node = el('button', text, secondary ? 'btn secondary' : 'btn');
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await handler();
    } catch (error) {
      showError(error);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

const styles = document.createElement('style');
styles.textContent = [
  ':root{font-family:"Open Sans","Segoe UI",sans-serif;color-scheme:light dark}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:transparent;font-size:14px;color:var(--atomic-text,inherit)}',
  '#root{padding:12px 0 30px;min-height:220px}',
  '.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 16px}',
  '.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.btn{font:inherit;font-size:13px;border:1px solid #1b50d8;background:#1b50d8;color:#fff;border-radius:9px;padding:7px 13px;min-height:34px;cursor:pointer}',
  '.btn.secondary{background:transparent;border-color:#c7cbd4;color:inherit}',
  '.btn:hover{filter:brightness(1.08)}.btn:disabled{opacity:.55;cursor:wait}',
  '.muted{color:#777;font-size:13px}.note{color:#666;font-size:12px;margin:10px 0}',
  '.error{border:1px solid #f4c2bc;background:#fff0ef;color:#9d2020;border-radius:8px;padding:12px;margin:10px 0}',
  '.empty{border:1px dashed #ccc;text-align:center;border-radius:10px;padding:35px 14px;margin:12px 0}',
  '.empty h3{margin:0 0 6px;font-size:17px}.empty p{color:#666}',
  '.grid{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed}',
  '.grid td,.grid th{border-bottom:1px solid #dedede;text-align:left;padding:10px 12px;vertical-align:middle;overflow-wrap:anywhere}',
  '.grid th{font-size:12px;color:#777;font-weight:600;background:rgba(128,128,128,.05)}',
  '.rowtitle{font-weight:600}.sub{display:block;font-size:12px;color:#777;margin-top:3px}',
  '.status{font-size:12px;border-radius:6px;padding:3px 7px;background:#ecf8f0;color:#2d6b42}',
  '.off{background:#f1f1f1;color:#6a6a6a}',
  '.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0 24px}',
  '.metric{border:1px solid #ddd;border-radius:9px;padding:12px}',
  '.metric strong{font-size:18px;display:block}.metric small{color:#777}',
  '@media(max-width:600px){.metric-row{grid-template-columns:1fr}.grid td,.grid th{padding:8px 5px;font-size:12px}}',
].join('\n');
document.head.appendChild(styles);

let root;
let api;
let current;
let state = { repositories: [], account: '', incomplete: false };
function renderBase(title, subtitle) {
  root.replaceChildren();
  const bar = el('div', null, 'toolbar');
  const heading = el('div');
  heading.append(el('strong', title));
  if (subtitle) heading.append(el('div', subtitle, 'muted'));
  bar.append(heading);
  root.append(bar);
  return bar;
}
function showError(error) {
  const previous = root.querySelector('.error');
  previous?.remove();
  const node = el('div', String(error?.message ?? error), 'error');
  node.setAttribute('role', 'alert');
  root.prepend(node);
}
function table(headers, entries) {
  const t = el('table', null, 'grid');
  const head = el('thead');
  const tr = el('tr');
  for (const header of headers) tr.append(el('th', header));
  head.append(tr); t.append(head);
  const body = el('tbody');
  for (const cells of entries) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      if (cell instanceof Node) td.append(cell); else td.textContent = String(cell ?? '');
      row.append(td);
    }
    body.append(row);
  }
  t.append(body); root.append(t);
}
function labelAndSub(title, sub) {
  const node = el('div');
  node.append(el('span', title, 'rowtitle'), el('small', sub, 'sub'));
  return node;
}
async function navigate(subject) {
  await api.ui.openResource(subject);
}
function validateId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid GitHub resource identity');
  return String(value);
}
function validLogin(text) {
  return typeof text === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(text);
}
function validRepo(text) {
  return typeof text === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(text);
}

/** The proxy already allows /user/repos; other org-list endpoints are not
 * enabled. Group repos by their canonical owner ID and type instead of
 * confusing OAuth account ownership with repository ownership.
 */
async function loadRepositories(connectionId) {
  const found = new Map();
  let incomplete = false;
  for (let page = 1; page <= 10; page++) {
    const response = await api.proxy.request({
      platform: current.platform,
      connectionId,
      path: '/user/repos',
      query: { per_page: '100', page: String(page) },
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error('GitHub repository discovery: HTTP ' + response.status);
    const records = response.body;
    if (!Array.isArray(records)) throw new Error('GitHub returned no repository list');
    for (const repo of records) {
      if (!repo || typeof repo !== 'object') continue;
      const owner = repo.owner;
      if (!owner || !validLogin(owner.login) || !validRepo(repo.name)) continue;
      if (!Number.isSafeInteger(owner.id) || !Number.isSafeInteger(repo.id)) continue;
      found.set(String(repo.id), {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: { id: owner.id, login: owner.login, type: owner.type === 'Organization' ? 'organization' : 'personal' },
        hasIssues: repo.has_issues !== false,
      });
    }
    if (records.length < 100) break;
    if (page === 10) incomplete = true;
  }
  state.repositories = [...found.values()];
  state.incomplete = incomplete;
  return state.repositories;
}
function ownerGroups() {
  const byId = new Map();
  for (const repo of state.repositories) {
    if (!byId.has(repo.owner.id)) byId.set(repo.owner.id, repo.owner);
  }
  return [...byId.values()].sort((a, b) => a.login.localeCompare(b.login));
}

async function renderAccounts() {
  const bar = renderBase('Connected GitHub accounts', 'One authorization may access several organizations.');
  bar.append(button('+ Connect account', async () => {
    const connection = await api.proxy.connect({ platform: current.platform });
    if (connection?.status === 'connected') await renderAccounts();
  }));
  const connected = await api.proxy.connections({ platform: current.platform });
  if (!Array.isArray(connected) || connected.length === 0) {
    const empty = el('div', null, 'empty');
    empty.append(el('h3', 'No accounts connected'), el('p', 'Connect GitHub to discover accessible organizations and repositories.'));
    empty.append(button('Connect GitHub account', async () => {
      const result = await api.proxy.connect({ platform: current.platform });
      if (result?.status === 'connected') await renderAccounts();
    }));
    root.append(empty);
    return;
  }
  table(['Account connection', 'Status', 'Action'], connected.map(c => [
    labelAndSub('GitHub', 'Connection reference ' + c.connectionId.slice(0, 12) + '…'),
    el('span', 'Connected', 'status'),
    button('Browse organizations', async () => {
      const result = await call('syncablesOpenAccount', { connectionId: c.connectionId });
      await navigate(result.subject);
    }, true),
  ]));
}

async function renderOrganizations() {
  const bar = renderBase('Organizations', 'GitHub organization and personal owner namespaces accessible through this account.');
  bar.append(button('↻ Refresh list', renderOrganizations, true));
  root.append(el('div', 'Loading repositories through GitHub…', 'muted'));
  const connectionId = current.connectionId;
  await loadRepositories(connectionId);
  const owners = ownerGroups();
  renderBase('Organizations', owners.length + ' owner namespaces found');
  if (state.incomplete) root.append(el('div', 'More than 1,000 repositories: discovery is incomplete, and no absent items will be deleted.', 'note'));
  table(['Owner namespace', 'Kind', 'Repositories', 'Action'], owners.map(owner => [
    labelAndSub(owner.login, 'GitHub owner ID ' + owner.id),
    owner.type === 'organization' ? 'Organization' : 'Personal owner',
    state.repositories.filter(r => r.owner.id === owner.id).length,
    button('Open', async () => {
      const result = await call('syncablesOpenOwner', {
        connectionId,
        ownerId: validateId(owner.id),
        ownerLogin: owner.login,
        ownerKind: owner.type,
      });
      await navigate(result.subject);
    }, true),
  ]));
}

async function renderRepositories() {
  renderBase('Repositories', 'Repositories belonging to ' + current.ownerLogin);
  root.append(el('div', 'Loading repository list…', 'muted'));
  const repos = await loadRepositories(current.connectionId);
  const selected = repos.filter(r => String(r.owner.id) === current.ownerId);
  const bar = renderBase('Repositories', current.ownerLogin + ' · ' + selected.length + ' visible repositories');
  bar.append(button('↻ Refresh list', renderRepositories, true));
  if (state.incomplete) root.append(el('div', 'Repository listing is incomplete; only the visible choices are shown.', 'note'));
  table(['Repository', 'Owner', 'Issues', 'Action'], selected.map(repo => [
    labelAndSub(repo.name, repo.fullName || current.ownerLogin + '/' + repo.name),
    current.ownerLogin,
    repo.hasIssues ? 'Available' : 'Disabled in GitHub',
    repo.hasIssues ? button('Sync issues', async () => {
      const result = await call('syncablesCreateMirror', {
        connectionId: current.connectionId,
        ownerId: current.ownerId,
        ownerLogin: current.ownerLogin,
        repoId: validateId(repo.id),
        repoName: repo.name,
      });
      await navigate(result.subject);
    }, true) : el('span', 'Unavailable', 'muted'),
  ]));
}

async function renderMirror() {
  const status = await call('syncablesMirrorStatus');
  const bar = renderBase('Issues sync', current.ownerLogin + '/' + current.repoName);
  const controls = el('div', null, 'controls');
  controls.append(button('↻ Sync now', syncIssues, false));
  controls.append(button(status.paused ? 'Resume' : 'Pause', async () => {
    await call('syncablesSetPaused', { paused: !status.paused });
    await renderMirror();
  }, true));
  bar.append(controls);
  const grid = el('div', null, 'metric-row');
  const cards = [
    [status.rows || 0, 'Imported issues'],
    [status.paused ? 'Paused' : status.error ? 'Needs attention' : 'Ready', 'Synchronization'],
    [status.lastSuccess || 'Never', 'Last successful sync'],
  ];
  for (const [value, label] of cards) {
    const item = el('div', null, 'metric');
    item.append(el('strong', value), el('small', label));
    grid.append(item);
  }
  root.append(grid);
  if (status.error) root.append(el('div', status.error, 'error'));
  root.append(el('p', 'Source: GitHub · ' + current.ownerLogin + '/' + current.repoName + ' · read-only via integration proxy.', 'note'));
  root.append(el('p', 'Use the Table tab to browse the imported rows. Pausing keeps them in your Atomic drive.', 'note'));
}

async function syncIssues() {
  const status = await call('syncablesMirrorStatus');
  if (status.paused) throw new Error('Resume this mirror before syncing.');
  const connectionId = current.connectionId;
  let imported = 0;
  let more = false;
  for (let page = 1; page <= 20; page++) {
    const reply = await api.proxy.request({
      platform: current.platform,
      connectionId,
      path: '/repos/' + encodeURIComponent(current.ownerLogin) + '/' + encodeURIComponent(current.repoName) + '/issues',
      query: { per_page: '100', page: String(page), state: 'all' },
    });
    if (reply.status < 200 || reply.status >= 300)
      throw new Error('Could not fetch GitHub issues: HTTP ' + reply.status);
    if (!Array.isArray(reply.body)) throw new Error('GitHub returned no issues list');
    const issues = reply.body.filter(item => !item?.pull_request).map(item => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      body: item.body,
      updatedAt: item.updated_at,
      htmlUrl: item.html_url,
    }));
    if (issues.length) {
      await call('syncablesImportIssues', { issues });
      imported += issues.length;
    }
    if (reply.body.length < 100) { more = false; break; }
    more = page === 20;
  }
  await call('syncablesRecordSuccess', { imported, incomplete: more });
  await renderMirror();
}

export async function view({ root: viewRoot, store }) {
  root = viewRoot;
  api = store;
  root.replaceChildren(el('p', 'Opening Syncables…', 'muted'));
  try {
    current = await call('syncablesContext');
    if (current.platform !== 'github-issues') {
      renderBase('Syncables', 'Generic API selection for ' + current.platform);
      root.append(el('p', 'This platform is in the catalog. Collection discovery is not enabled for this platform yet.', 'muted'));
      return;
    }
    switch (current.kind) {
      case 'platform': await renderAccounts(); break;
      case 'organizations': await renderOrganizations(); break;
      case 'repositories': await renderRepositories(); break;
      case 'mirror': await renderMirror(); break;
      default: throw new Error('Unknown Syncables resource kind');
    }
  } catch (error) {
    renderBase('Syncables', 'Could not open this view');
    showError(error);
    root.append(button('Try again', async () => view({ root, store }), true));
  }
}
