// @wc-ignore-file
import { viewRequest } from '../../../../../plugin/src/viewProtocol';
import type { SnapshotTable } from './snapshotHost';

/** Concrete plugin view, reusable with a live authoring host or a frozen snapshot host. */
export async function view({
  root,
  store,
}: {
  root: HTMLElement;
  store: { data(): Promise<SnapshotTable> };
}) {
  const table = await store.data();
  const label = document.createElement('label');
  label.textContent = `Search ${table.title}`;
  const input = document.createElement('input');
  input.type = 'search';
  input.setAttribute('aria-label', label.textContent);
  label.append(input);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const cards = document.createElement('div');
  cards.className = 'cards';
  root.replaceChildren(label, status, cards);

  function render() {
    const query = input.value.toLocaleLowerCase().trim();
    const rows = table.rows.filter(row =>
      row.some(value => value.toLocaleLowerCase().includes(query)),
    );
    status.textContent = rows.length
      ? `${rows.length} results`
      : 'No matching results';
    cards.replaceChildren(
      ...rows.map(row => {
        const card = document.createElement('dl');
        card.className = 'card';
        row.forEach((value, index) => {
          const key = document.createElement('dt');
          key.textContent = table.columns[index];
          const text = document.createElement('dd');
          text.textContent = value;
          card.append(key, text);
        });

        return card;
      }),
    );
  }

  input.addEventListener('input', render);
  render();
}

const host =
  new URLSearchParams(location.search).get('host') === 'top'
    ? window.top!
    : parent;
const pending = new Map<
  string,
  { resolve(value: SnapshotTable): void; reject(error: Error): void }
>();
window.addEventListener('message', event => {
  if (
    event.source !== host ||
    event.data?.type !== 'atomic.view.response' ||
    event.data.version !== 1
  )
    return;
  const handler = pending.get(event.data.id);
  if (!handler) return;
  pending.delete(event.data.id);
  if (event.data.error) handler.reject(new Error(event.data.error));
  else handler.resolve(event.data.result);
});
host.postMessage({ type: '__atomic_plugin_ready' }, '*');
view({
  root: document.body,
  store: {
    data: () =>
      new Promise((resolve, reject) => {
        const id = 'snapshot';
        pending.set(id, { resolve, reject });
        host.postMessage(viewRequest(id, 'data'), '*');
      }),
  },
})
  .then(() => host.postMessage({ type: '__atomic_plugin_rendered' }, '*'))
  .catch(error => {
    document.body.textContent = `Cannot load this view: ${String(error)}`;
  });
