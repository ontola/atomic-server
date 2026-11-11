// Team tasks: a live overview of the Tasks table.
// It only reads: the rows stay in the Tasks table, so the board and this page never disagree.
const TASKS = '__TASKS__';
const P = 'https://atomicdata.dev/';
const NAME = P + 'properties/name';
const PARENT = P + 'properties/parent';
const STATUS = P + 'task/v1/status';
const DUE = P + 'task/v1/due-date';
const WHO = P + 'task/v1/assignee';
const EST = '__ESTIMATE__';

const COLUMNS = [
  { id: 'todo', label: 'To do', color: '#64748b', tint: '#f1f5f9' },
  { id: 'doing', label: 'In progress', color: '#2563eb', tint: '#eff6ff' },
  { id: 'blocked', label: 'Blocked', color: '#d97706', tint: '#fffbeb' },
  { id: 'done', label: 'Done', color: '#16a34a', tint: '#f0fdf4' },
];

const CSS = `
  .tt { font-family: 'Open Sans', system-ui, sans-serif; color: #0f172a; padding: 28px 32px 36px; max-width: 1080px; margin: 0 auto; }
  .tt h1 { font-size: 28px; margin: 0; letter-spacing: -0.01em; }
  .tt .sub { color: #64748b; margin: 4px 0 22px; font-size: 15px; }
  .tt .hero { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px 22px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
  .tt .hero-top { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
  .tt .pct { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }
  .tt .pct small { font-size: 15px; font-weight: 500; color: #64748b; margin-left: 8px; letter-spacing: 0; }
  .tt .bar { display: flex; height: 14px; border-radius: 999px; overflow: hidden; background: #e2e8f0; }
  .tt .bar span { display: block; height: 100%; }
  .tt .legend { display: flex; gap: 18px; margin-top: 12px; font-size: 13px; color: #475569; flex-wrap: wrap; }
  .tt .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
  .tt .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 16px 0; }
  .tt .card { border-radius: 14px; padding: 16px 18px; border: 1px solid transparent; }
  .tt .card .n { font-size: 34px; font-weight: 700; line-height: 1; }
  .tt .card .l { font-weight: 600; margin-top: 8px; font-size: 14px; }
  .tt .card .h { font-size: 13px; color: #64748b; margin-top: 2px; }
  .tt .cols { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; }
  .tt .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
  .tt .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin: 0 0 14px; }
  .tt .person { display: grid; grid-template-columns: 30px 64px 1fr 44px; gap: 10px; align-items: center; margin-bottom: 12px; font-size: 14px; }
  .tt .avatar { width: 28px; height: 28px; border-radius: 50%; color: #fff; font-weight: 700; display: grid; place-items: center; font-size: 13px; }
  .tt .track { height: 10px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
  .tt .track span { display: block; height: 100%; border-radius: 999px; background: #2563eb; }
  .tt .hrs { text-align: right; color: #64748b; font-variant-numeric: tabular-nums; }
  .tt .due { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid #f1f5f9; font-size: 14px; }
  .tt .due:first-of-type { border-top: 0; padding-top: 0; }
  .tt .due b { flex: 1; font-weight: 600; }
  .tt .pill { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
  .tt .date { color: #64748b; font-variant-numeric: tabular-nums; width: 52px; text-align: right; }
`;

const COLORS = ['#7c3aed', '#db2777', '#0891b2', '#ea580c', '#65a30d'];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;

  return e;
}

export async function view({ root, store }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  const page = el('div', 'tt');
  root.append(style, page);

  const subjects = await store.query({ property: PARENT, value: TASKS });
  const rows = [];

  for (const subject of subjects) {
    const r = await store.getResource(subject);
    const tags = r.get(STATUS) || [];
    if (!tags.length) continue; // views and other children of the table are not tasks
    rows.push({
      name: r.get(NAME) || 'Untitled',
      status: String(tags[0] || '')
        .split('/')
        .pop(),
      due: r.get(DUE) || '',
      who: r.get(WHO) || 'Unassigned',
      est: Number(r.get(EST) || 0),
    });
  }

  const total = rows.length;
  const hours = rows.reduce((s, r) => s + r.est, 0);
  const by = id => rows.filter(r => r.status === id);
  const sum = list => list.reduce((s, r) => s + r.est, 0);
  const doneHours = sum(by('done'));
  const pct = hours ? Math.round((doneHours / hours) * 100) : 0;

  page.append(el('h1', '', 'Team tasks'));
  page.append(
    el(
      'div',
      'sub',
      total + ' tasks, ' + hours + ' hours planned for the launch',
    ),
  );

  const hero = el('div', 'hero');
  const top = el('div', 'hero-top');
  const big = el('div', 'pct', pct + '%');
  big.append(el('small', '', 'of planned hours done'));
  top.append(big);
  const bar = el('div', 'bar');
  const legend = el('div', 'legend');

  for (const c of COLUMNS) {
    const h = sum(by(c.id));
    const seg = el('span');
    seg.style.width = (hours ? (h / hours) * 100 : 0) + '%';
    seg.style.background = c.color;
    bar.append(seg);
    const item = el('span', '', c.label + ' ' + h + 'h');
    const dot = el('i', 'dot');
    dot.style.background = c.color;
    item.prepend(dot);
    legend.append(item);
  }

  hero.append(top, bar, legend);
  page.append(hero);

  const cards = el('div', 'cards');

  for (const c of COLUMNS) {
    const list = by(c.id);
    const card = el('div', 'card');
    card.style.background = c.tint;
    card.style.borderColor = c.color + '33';
    const n = el('div', 'n', String(list.length));
    n.style.color = c.color;
    card.append(
      n,
      el('div', 'l', c.label),
      el('div', 'h', sum(list) + ' hours'),
    );
    cards.append(card);
  }

  page.append(cards);

  const cols = el('div', 'cols');

  const load = el('div', 'panel');
  load.append(el('h2', '', 'Open work per person'));
  const people = {};

  for (const r of rows) {
    const first = r.who.split(' ')[0];
    if (r.status !== 'done') people[first] = (people[first] || 0) + r.est;
  }

  const names = Object.keys(people).sort((a, b) => people[b] - people[a]);
  const max = Math.max(1, ...names.map(n => people[n]));
  names.forEach((who, i) => {
    const row = el('div', 'person');
    const av = el('div', 'avatar', who[0]);
    av.style.background = COLORS[i % COLORS.length];
    const track = el('div', 'track');
    const fill = el('span');
    fill.style.width = (people[who] / max) * 100 + '%';
    track.append(fill);
    row.append(
      av,
      el('div', '', who),
      track,
      el('div', 'hrs', people[who] + 'h'),
    );
    load.append(row);
  });

  const next = el('div', 'panel');
  next.append(el('h2', '', 'Due next'));
  const upcoming = rows
    .filter(r => r.status !== 'done')
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 5);

  for (const r of upcoming) {
    const c = COLUMNS.find(x => x.id === r.status) || COLUMNS[0];
    const line = el('div', 'due');
    const pill = el('span', 'pill', c.label);
    pill.style.background = c.tint;
    pill.style.color = c.color;
    const d = new Date(r.due + 'T00:00:00');
    line.append(
      el('b', '', r.name),
      pill,
      el(
        'span',
        'date',
        isNaN(d)
          ? ''
          : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ),
    );
    next.append(line);
  }

  cols.append(load, next);
  page.append(cols);
}
