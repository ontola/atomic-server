import type { LoroDoc, LoroList } from 'loro-crdt';
import { LoroLoader } from '@tomic/lib';

/**
 * The body of a DocumentV2 written from Markdown text, as the Rust host does
 * for a document made from a template (`atomic_lib::document_markdown::
 * write_document_text`): headings, paragraphs, lists (bullet, ordered,
 * tasks, nested by indent), quotes, rules, and bold, italic, code and links
 * inside a line. For the memory host, which has no Rust behind it.
 */
export function writeDocumentText(doc: LoroDoc, text: string): void {
  const { LoroMap, LoroList } = LoroLoader.Loro;

  doc.configTextStyle({
    bold: { expand: 'after' },
    italic: { expand: 'after' },
    strike: { expand: 'after' },
    code: { expand: 'none' },
    link: { expand: 'none' },
  });

  const root = doc.getMap('doc');
  root.set('nodeName', 'doc');
  root.setContainer('attributes', new LoroMap());
  const children = root.setContainer('children', new LoroList());
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (const block of parseBlocks(lines)) writeBlock(children, block);

  doc.commit();
}

type Marks = Record<string, Record<string, string>>;
type Run = { text: string; marks: Marks };
type Item = { checked?: boolean; runs: Run[]; children: Block[] };
type ListKind = 'bulletList' | 'orderedList' | 'taskList';
type Block =
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'rule' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; list: ListKind; items: Item[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const isRule = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
const isQuote = (line: string) => line.trimStart().startsWith('>');
const indentOf = (line: string) => line.length - line.trimStart().length;

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        runs: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (isQuote(line)) {
      const quoted: string[] = [];

      while (i < lines.length && isQuote(lines[i])) {
        quoted.push(lines[i].trimStart().slice(1).replace(/^ /, ''));
        i++;
      }

      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const listLines: string[] = [];

      while (
        i < lines.length &&
        lines[i].trim() &&
        (LIST_ITEM.test(lines[i]) || /^\s/.test(lines[i]))
      ) {
        listLines.push(lines[i]);
        i++;
      }

      blocks.push(...parseLists(listLines));
      continue;
    }

    blocks.push({ kind: 'paragraph', runs: parseInline(line.trim()) });
    i++;
  }

  return blocks;
}

/** Items at the shallowest indent make a list; deeper lines nest in them. */
function parseLists(lines: string[]): Block[] {
  const base = Math.min(...lines.map(indentOf));
  const blocks: Block[] = [];
  let current: { list: ListKind; items: Item[] } | undefined;
  let nested: string[] = [];

  const flushNested = () => {
    const last = current?.items.at(-1);

    if (last && nested.length) last.children.push(...parseLists(nested));

    nested = [];
  };

  for (const line of lines) {
    const m = LIST_ITEM.exec(line);

    if (!m || indentOf(line) > base) {
      nested.push(line);
      continue;
    }

    flushNested();
    const task = TASK.exec(m[3]);
    const list: ListKind = /\d/.test(m[2])
      ? 'orderedList'
      : task
        ? 'taskList'
        : 'bulletList';

    if (!current || current.list !== list) {
      current = { list, items: [] };
      blocks.push({ kind: 'list', ...current });
    }

    current.items.push({
      checked: task ? task[1] !== ' ' : undefined,
      runs: parseInline(task ? task[2] : m[3]),
      children: [],
    });
  }

  flushNested();

  return blocks;
}

/** `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` `` and
 *  `[text](href)`; anything else is plain text. */
export function parseInline(text: string, marks: Marks = {}): Run[] {
  const runs: Run[] = [];
  // No lookbehind (Safari < 16.4): the character before an italic marker is
  // matched as a group of its own and kept as plain text.
  const pattern =
    /\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(^|[^\w*])\*(?![\s*])(.+?)\*(?![\w*])|(^|\W)_(?![\s_])(.+?)_(?!\w)/g;
  let at = 0;

  for (const m of text.matchAll(pattern)) {
    const lead = m[7] ?? m[9] ?? '';
    const start = m.index + lead.length;

    if (start > at) runs.push({ text: text.slice(at, start), marks });

    if (m[1] ?? m[2]) {
      runs.push(...parseInline(m[1] ?? m[2], { ...marks, bold: {} }));
    } else if (m[3]) {
      runs.push(...parseInline(m[3], { ...marks, strike: {} }));
    } else if (m[4]) {
      runs.push({ text: m[4], marks: { ...marks, code: {} } });
    } else if (m[5]) {
      runs.push(...parseInline(m[5], { ...marks, link: { href: m[6] } }));
    } else {
      runs.push(...parseInline(m[8] ?? m[10], { ...marks, italic: {} }));
    }

    at = m.index + m[0].length;
  }

  if (at < text.length) runs.push({ text: text.slice(at), marks });

  return runs;
}

function node(
  parent: LoroList,
  name: string,
  attributes: Record<string, unknown> = {},
): LoroList {
  const { LoroMap, LoroList } = LoroLoader.Loro;
  const map = parent.pushContainer(new LoroMap());
  map.set('nodeName', name);
  const attrs = map.setContainer('attributes', new LoroMap());

  for (const [key, value] of Object.entries(attributes)) {
    attrs.set(key, value as never);
  }

  return map.setContainer('children', new LoroList());
}

function writeRuns(parent: LoroList, runs: Run[]): void {
  const filled = runs.filter(r => r.text);

  if (!filled.length) return;

  const text = parent.pushContainer(new LoroLoader.Loro.LoroText());
  let at = 0;

  for (const run of filled) {
    const length = [...run.text].length;
    text.insert(at, run.text);

    for (const [name, value] of Object.entries(run.marks)) {
      text.mark({ start: at, end: at + length }, name, value);
    }

    at += length;
  }
}

function writeBlock(parent: LoroList, block: Block): void {
  switch (block.kind) {
    case 'paragraph':
      writeRuns(node(parent, 'paragraph'), block.runs);
      break;

    case 'heading':
      writeRuns(node(parent, 'heading', { level: block.level }), block.runs);
      break;

    case 'rule':
      node(parent, 'horizontalRule');
      break;

    case 'quote': {
      const children = node(parent, 'blockquote');

      for (const child of block.blocks) writeBlock(children, child);

      break;
    }

    case 'list': {
      const list = node(parent, block.list);
      const task = block.list === 'taskList';

      for (const item of block.items) {
        const children = node(
          list,
          task ? 'taskItem' : 'listItem',
          task ? { checked: item.checked === true } : {},
        );
        writeRuns(node(children, 'paragraph'), item.runs);

        for (const child of item.children) writeBlock(children, child);
      }

      break;
    }
  }
}
