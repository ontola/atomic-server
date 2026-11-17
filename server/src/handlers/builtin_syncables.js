// @wc-ignore-file
/*
 * Atomic Server's built-in Syncables view. This file is shipped with the
 * server, never supplied by a provider. It runs inside the existing CSP-
 * sandboxed, null-origin iframe with no direct network access.
 *
 * The existing frame bridge carries scoped discovery, reads and provisioning.
 */
const pending = new Map();
let serial = 0;

window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.type !== 'atomic.view.response' || message.version !== 1) return;
  if (typeof message.id !== 'string' || !message.id.startsWith('syncables:'))
    return;
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
    window.parent.postMessage(
      {
        type: 'atomic.view.request',
        version: 1,
        id,
        op,
        args,
      },
      '*',
    );
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
let current;
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
  head.append(tr);
  t.append(head);
  const body = el('tbody');
  for (const cells of entries) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = String(cell ?? '');
      row.append(td);
    }
    body.append(row);
  }
  t.append(body);
  root.append(t);
}
function labelAndSub(title, sub) {
  const node = el('div');
  node.append(el('span', title, 'rowtitle'), el('small', sub, 'sub'));
  return node;
}
function validateId(value) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid GitHub resource identity');
  return String(value);
}
function validLogin(text) {
  return typeof text === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(text);
}
function validRepo(text) {
  return typeof text === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(text);
}

async function readPages(read, onPage) {
  for (let page = 1; page <= 20; page++) {
    const result = await call('syncablesRead', { read, page });
    if (result.status < 200 || result.status >= 300)
      throw new Error('GitHub read failed (HTTP ' + result.status + ').');
    if (!Array.isArray(result.body) || result.body.length > 100)
      throw new Error('GitHub returned an invalid ' + read + ' page.');
    await onPage(result.body);
    if (!result.nextPage) return true;
  }
  return false;
}

async function loadRepositories() {
  const found = new Map();
  const complete = await readPages('repositories', records => {
    for (const repo of records) {
      if (!repo || typeof repo !== 'object') continue;
      const owner = repo.owner;
      if (!owner || !validLogin(owner.login) || !validRepo(repo.name)) continue;
      if (!Number.isSafeInteger(owner.id) || !Number.isSafeInteger(repo.id))
        continue;
      found.set(String(repo.id), {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: {
          id: owner.id,
          login: owner.login,
          type: owner.type === 'Organization' ? 'organization' : 'personal',
        },
        hasIssues: repo.has_issues !== false,
      });
    }
  });
  return { repos: [...found.values()], complete };
}

async function connectAccount() {
  await call('syncablesConnect');
}

function reconnectButton(connectionId) {
  return button(
    'Reconnect',
    async () => {
      await call('syncablesConnect', { connectionId });
    },
    true,
  );
}

async function renderAccounts() {
  const bar = renderBase(
    'Connected GitHub accounts',
    'Discover organizations and repositories available to your account.',
  );
  bar.append(button('Connect account', connectAccount));
  const connected = await call('syncablesAccounts');
  if (connected.length === 0) {
    const empty = el('div', null, 'empty');
    empty.append(
      el('h3', 'No accounts connected'),
      el(
        'p',
        'Connect GitHub to discover accessible organizations and repositories.',
      ),
    );
    empty.append(button('Connect GitHub account', connectAccount));
    root.append(empty);
    return;
  }
  table(
    ['Account', 'Status', 'Action'],
    connected.map(account => [
      el('span', account.login, 'rowtitle'),
      el('span', account.healthy ? 'Connected' : 'Needs attention', 'status'),
      account.healthy
        ? button(
            'Browse organizations',
            async () => {
              await call('syncablesOpenAccount', {
                connectionId: account.connectionId,
              });
            },
            true,
          )
        : account.canReconnect
          ? reconnectButton(account.connectionId)
          : el('span', 'Connect again from this table.', 'muted'),
    ]),
  );
}

async function renderOrganizations() {
  renderBase('Organizations', 'Loading GitHub owner namespaces…');
  const connectionId = current.connectionId;
  const { repos, complete } = await loadRepositories();
  const found = new Map(repos.map(repo => [repo.owner.id, repo.owner]));
  const profile = await call('syncablesRead', { read: 'profile' });
  if (profile.status === 200 && validLogin(profile.body?.login))
    found.set(profile.body.id, {
      id: profile.body.id,
      login: profile.body.login,
      type: 'personal',
    });

  let collectionComplete = true;
  try {
    collectionComplete = await readPages('owners', organizations => {
      for (const org of organizations) {
        if (validLogin(org?.login))
          found.set(org.id, {
            id: org.id,
            login: org.login,
            type: 'organization',
          });
      }
    });
  } catch {
    collectionComplete = false;
  }
  const owners = [...found.values()].sort((a, b) =>
    a.login.localeCompare(b.login),
  );
  for (let i = 0; i < owners.length; i += 100) {
    await call('syncablesDiscoverOwners', {
      owners: owners.slice(i, i + 100).map(owner => ({
        id: validateId(owner.id),
        login: owner.login,
        type: owner.type,
      })),
    });
  }
  const bar = renderBase(
    'Organizations',
    owners.length + ' owner namespaces found',
  );
  bar.append(button('Refresh list', renderOrganizations, true));
  if (!complete || !collectionComplete)
    root.append(
      el(
        'p',
        'GitHub returned an incomplete owner list. Refresh to try again.',
        'note',
      ),
    );
  table(
    ['Owner namespace', 'Kind', 'Repositories', 'Action'],
    owners.map(owner => [
      labelAndSub(owner.login, 'GitHub owner ID ' + owner.id),
      owner.type === 'organization' ? 'Organization' : 'Personal owner',
      repos.filter(repo => repo.owner.id === owner.id).length,
      button(
        'Open',
        async () => {
          await call('syncablesOpenOwner', {
            connectionId,
            ownerId: validateId(owner.id),
            ownerLogin: owner.login,
            ownerKind: owner.type,
          });
        },
        true,
      ),
    ]),
  );
}

async function renderRepositories() {
  renderBase('Repositories', 'Repositories belonging to ' + current.ownerLogin);
  root.append(el('div', 'Loading repository list…', 'muted'));
  const { repos, complete } = await loadRepositories();
  const selected = repos.filter(r => String(r.owner.id) === current.ownerId);
  for (let i = 0; i < selected.length; i += 100) {
    await call('syncablesDiscoverRepos', {
      repos: selected.slice(i, i + 100).map(repo => ({
        id: validateId(repo.id),
        name: repo.name,
      })),
    });
  }
  const bar = renderBase(
    'Repositories',
    current.ownerLogin + ' · ' + selected.length + ' visible repositories',
  );
  bar.append(button('↻ Refresh list', renderRepositories, true));
  if (!complete)
    root.append(
      el(
        'div',
        'Repository listing is incomplete; only the visible choices are shown.',
        'note',
      ),
    );
  table(
    ['Repository', 'Owner', 'Issues', 'Action'],
    selected.map(repo => [
      labelAndSub(
        repo.name,
        repo.fullName || current.ownerLogin + '/' + repo.name,
      ),
      current.ownerLogin,
      repo.hasIssues ? 'Available' : 'Disabled in GitHub',
      repo.hasIssues
        ? button(
            'Sync issues',
            async () => {
              await call('syncablesCreateMirror', {
                connectionId: current.connectionId,
                ownerId: current.ownerId,
                ownerLogin: current.ownerLogin,
                repoId: validateId(repo.id),
                repoName: repo.name,
              });
            },
            true,
          )
        : el('span', 'Unavailable', 'muted'),
    ]),
  );
}

async function renderMirror() {
  const status = await call('syncablesMirrorStatus');
  const bar = renderBase(
    'Issues sync',
    current.ownerLogin + '/' + current.repoName,
  );
  const controls = el('div', null, 'controls');
  if (!status.paused) controls.append(button('Sync now', syncIssues));
  controls.append(
    button(
      status.paused ? 'Resume' : 'Pause',
      async () => {
        await call('syncablesSetPaused', { paused: !status.paused });
        await renderMirror();
      },
      true,
    ),
  );
  if (status.error && current.canReconnect)
    controls.append(reconnectButton(current.connectionId));
  bar.append(controls);
  const grid = el('div', null, 'metric-row');
  const cards = [
    [status.rows || 0, 'Imported issues'],
    [
      status.paused ? 'Paused' : status.error ? 'Needs attention' : 'Ready',
      'Synchronization',
    ],
    [status.lastSuccess || 'Never', 'Last successful sync'],
  ];
  for (const [value, label] of cards) {
    const item = el('div', null, 'metric');
    item.append(el('strong', value), el('small', label));
    grid.append(item);
  }
  root.append(grid);
  if (status.lastSuccess || status.incomplete) {
    root.append(
      el(
        'p',
        status.added +
          ' added · ' +
          status.changed +
          ' changed · ' +
          status.unchanged +
          ' unchanged',
        'note',
      ),
    );
  }
  if (status.error) root.append(el('div', status.error, 'error'));
  root.append(
    el(
      'p',
      'Source: GitHub · ' +
        current.ownerLogin +
        '/' +
        current.repoName +
        ' · read-only via integration proxy.',
      'note',
    ),
  );
  root.append(
    el(
      'p',
      'Use the Table tab to browse the imported rows. Pausing keeps them in your Atomic drive.',
      'note',
    ),
  );
}

async function syncIssues() {
  try {
    const counts = { added: 0, changed: 0, unchanged: 0 };
    const seen = new Set();
    const complete = await readPages('issues', async records => {
      const issues = [];
      for (const item of records) {
        if (!item || typeof item !== 'object')
          throw new Error('Invalid GitHub issue row.');
        if (item.pull_request || seen.has(item.id)) continue;
        seen.add(item.id);
        issues.push({
          id: item.id,
          number: item.number,
          title: item.title,
          state: item.state,
          body: item.body,
          updatedAt: item.updated_at,
          htmlUrl: item.html_url,
        });
      }
      if (issues.length === 0) return;
      const result = await call('syncablesImportIssues', { issues });
      for (const key of Object.keys(counts)) counts[key] += result[key];
    });
    await call('syncablesRecordSuccess', {
      ...counts,
      imported: counts.added + counts.changed + counts.unchanged,
      incomplete: !complete,
    });
    await renderMirror();
  } catch (error) {
    await call('syncablesRecordFailure', {
      message: String(error?.message ?? error).slice(0, 1024),
    }).catch(() => undefined);
    await renderMirror();
    throw error;
  }
}

export async function view({ root: viewRoot }) {
  root = viewRoot;
  root.replaceChildren(el('p', 'Opening Syncables…', 'muted'));
  try {
    current = await call('syncablesContext');
    if (current.platform !== 'github-issues') {
      renderBase('Syncables', 'Generic API selection for ' + current.platform);
      root.append(
        el(
          'p',
          'This platform is in the catalog. Collection discovery is not enabled for this platform yet.',
          'muted',
        ),
      );
      return;
    }
    switch (current.kind) {
      case 'platform':
        await renderAccounts();
        break;
      case 'organizations':
        await renderOrganizations();
        break;
      case 'repositories':
        await renderRepositories();
        break;
      case 'mirror':
        await renderMirror();
        break;
      default:
        throw new Error('Unknown Syncables resource kind');
    }
  } catch (error) {
    renderBase('Syncables', 'Could not open this view');
    showError(error);
    root.append(button('Try again', async () => view({ root }), true));
    if (current?.canReconnect)
      root.append(reconnectButton(current.connectionId));
  }
}
