// @wc-ignore-file

export interface TimesheetTerms {
  name: string;
  start: string;
  end: string;
  billable: string;
}

/**
 * The table view of the demo: a week of time entries grouped by day, with
 * totals. Strictly a view. It knows the row class's properties and nothing
 * about any platform; the integration is a separate piece.
 *
 * Plain JS run in the drive-app frame (`view({ root, store })`), so it is a
 * string here, like `STARTER_APP_SOURCE`.
 */
export function timesheetSource(terms: TimesheetTerms): string {
  return `// Timesheet: a table view for time entries. No sync, no platform.
const T = ${JSON.stringify(terms)};
const PARENT = 'https://atomicdata.dev/properties/parent';

const css = \`
  :host, body { font-family: var(--t-font-family, system-ui, sans-serif); color: var(--t-color-text, #1b1b1f); background: var(--t-color-bg, #fff); margin: 0; }
  .wrap { padding: 1rem 1.25rem; max-width: 52rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .25rem; }
  .sub { color: var(--t-color-text-light, #666); font-size: .85rem; margin-bottom: 1rem; }
  .day { margin-bottom: 1rem; border: 1px solid var(--t-color-bg2, #e6e6ea); border-radius: 8px; overflow: hidden; }
  .day header { display: flex; justify-content: space-between; padding: .5rem .75rem; background: var(--t-color-bg1, #f6f6f8); font-weight: 600; font-size: .9rem; }
  .entry { display: grid; grid-template-columns: 1fr 10rem 4.5rem 6.5rem; gap: .5rem; padding: .45rem .75rem; border-top: 1px solid var(--t-color-bg2, #eee); font-size: .9rem; align-items: center; }
  .muted { color: var(--t-color-text-light, #777); }
  .tag { font-size: .75rem; padding: .1rem .4rem; border-radius: 99px; background: #e7f5ec; color: #19693a; justify-self: start; }
  .tag.no { background: #f1f1f4; color: #666; }
  .running { color: #b25e00; }
  .totals { display: flex; gap: 1.5rem; font-size: .95rem; margin-top: .5rem; }
  .totals b { font-size: 1.1rem; }
  @media (max-width: 540px) { .entry { grid-template-columns: 1fr 5.5rem; } .entry .hide-sm { display: none; } }
\`;

const hours = ms => (ms / 3600000).toFixed(2).replace(/\\.?0+$/, '') || '0';
const time = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

export async function view({ root, store }) {
  const { table, rowClass } = await store.getData();
  const style = document.createElement('style');
  style.textContent = css;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.append(style, wrap);

  async function render() {
    const subjects = await store.query({ property: PARENT, value: table, sortBy: T.start });
    const rows = await Promise.all(subjects.map(s => store.getResource(s)));
    const entries = rows
      .filter(r => r.getClasses().includes(rowClass))
      .map(r => ({ name: r.get(T.name) ?? 'Untitled', start: r.get(T.start), end: r.get(T.end), billable: r.get(T.billable) === true }))
      .filter(e => typeof e.start === 'number')
      .sort((a, b) => a.start - b.start);

    const byDay = new Map();
    for (const e of entries) {
      const k = dayKey(e.start);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }

    let total = 0, billable = 0;
    wrap.textContent = '';
    const h = document.createElement('h2');
    h.textContent = 'Timesheet';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'A table view for time entries. It reads this table\\'s rows and nothing else.';
    wrap.append(h, sub);

    for (const [k, list] of byDay) {
      const day = document.createElement('section');
      day.className = 'day';
      const head = document.createElement('header');
      let dayTotal = 0;
      for (const e of list) if (typeof e.end === 'number') dayTotal += e.end - e.start;
      head.innerHTML = '<span></span><span></span>';
      head.children[0].textContent = new Date(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      head.children[1].textContent = hours(dayTotal) + ' h';
      day.append(head);

      for (const e of list) {
        const line = document.createElement('div');
        line.className = 'entry';
        const dur = typeof e.end === 'number' ? e.end - e.start : undefined;
        if (dur !== undefined) { total += dur; if (e.billable) billable += dur; }
        line.innerHTML = '<span></span><span class="muted"></span><span></span><span class="tag hide-sm"></span>';
        line.children[0].textContent = e.name;
        line.children[1].textContent = time(e.start) + ' – ' + (dur === undefined ? '…' : time(e.end));
        line.children[2].textContent = dur === undefined ? 'running' : hours(dur) + ' h';
        if (dur === undefined) line.children[2].className = 'running';
        line.children[3].textContent = e.billable ? 'billable' : 'not billable';
        if (!e.billable) line.children[3].className = 'tag no hide-sm';
        day.append(line);
      }
      wrap.append(day);
    }

    const totals = document.createElement('div');
    totals.className = 'totals';
    totals.innerHTML = '<span>Total <b></b></span><span>Billable <b></b></span>';
    totals.querySelectorAll('b')[0].textContent = hours(total) + ' h';
    totals.querySelectorAll('b')[1].textContent = hours(billable) + ' h';
    wrap.append(totals);
  }

  await render();
  store.subscribe(table, () => render());
}
`;
}
