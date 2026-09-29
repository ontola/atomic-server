import { LoroList, LoroMap, LoroText, type LoroDoc } from 'loro-crdt';

/**
 * Writes the rich-text body of a document or meeting from Markdown or plain
 * text. The mirror of `documentText`: it builds the loro-prosemirror tree
 * directly (a map per node with `nodeName`, `attributes` and `children`, and
 * `LoroText` for text runs), so no editor schema is needed. The editor reads
 * it back like any body typed in the app; attributes left out take the
 * schema's defaults.
 *
 * Supported: headings, paragraphs, fenced code, horizontal rules, block
 * quotes, bullet, numbered and task lists (nested by indentation), and inline
 * **bold**, *italic*, ~~strike~~, `code` and [links](url). Every non-blank
 * line outside a list or code block becomes its own paragraph, which is also
 * how `documentText` reads a body back.
 */

type Marks = Record<string, Record<string, unknown>>;
interface Run {
  text: string;
  marks: Marks;
}
type Block =
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'heading'; level: number; runs: Run[] }
  | { type: 'codeBlock'; language: string | null; text: string }
  | { type: 'horizontalRule' }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'list'; kind: ListKind; items: Item[] };
type ListKind = 'bulletList' | 'orderedList' | 'taskList';
interface Item {
  checked?: boolean;
  runs: Run[];
  children: Block[];
}

const MARK_NAMES = ['bold', 'italic', 'strike', 'code', 'link'];

/** Replaces the body of `doc` with `text`. The caller saves the resource. */
export function writeDocumentText(doc: LoroDoc, text: string): void {
  // Marks need their style registered, as the editor does on load.
  doc.configTextStyle(
    Object.fromEntries(
      MARK_NAMES.map(name => [
        name,
        { expand: name === 'link' || name === 'code' ? 'none' : 'after' },
      ]),
    ) as Parameters<LoroDoc['configTextStyle']>[0],
  );

  const root = doc.getMap('doc');
  root.set('nodeName', 'doc');
  root.setContainer('attributes', new LoroMap());

  // A fresh list replaces whatever body was there.
  const children = root.setContainer('children', new LoroList());

  for (const block of parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'))) {
    writeBlock(children, block);
  }

  doc.commit();
}

function node(
  parent: LoroList,
  nodeName: string,
  attributes: Record<string, unknown> = {},
): LoroList {
  const map = parent.pushContainer(new LoroMap());
  map.set('nodeName', nodeName);
  const attrs = map.setContainer('attributes', new LoroMap());

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) attrs.set(key, value as string);
  }

  return map.setContainer('children', new LoroList());
}

function writeRuns(parent: LoroList, runs: Run[]): void {
  const nonEmpty = runs.filter(run => run.text.length > 0);

  if (nonEmpty.length === 0) return;

  const text = parent.pushContainer(new LoroText());
  text.applyDelta(
    nonEmpty.map(({ text: insert, marks }) => ({
      insert,
      ...(Object.keys(marks).length > 0
        ? { attributes: marks as Record<string, never> }
        : {}),
    })),
  );
}

function writeBlock(parent: LoroList, block: Block): void {
  switch (block.type) {
    case 'paragraph':
      writeRuns(node(parent, 'paragraph'), block.runs);

      return;
    case 'heading':
      writeRuns(node(parent, 'heading', { level: block.level }), block.runs);

      return;

    case 'codeBlock': {
      const children = node(parent, 'codeBlock', {
        language: block.language,
      });

      if (block.text) {
        children.pushContainer(new LoroText()).insert(0, block.text);
      }

      return;
    }

    case 'horizontalRule':
      node(parent, 'horizontalRule');

      return;

    case 'blockquote': {
      const children = node(parent, 'blockquote');

      for (const child of block.children) writeBlock(children, child);

      return;
    }

    case 'list': {
      const list = node(parent, block.kind);

      for (const item of block.items) {
        const isTask = block.kind === 'taskList';
        const children = node(
          list,
          isTask ? 'taskItem' : 'listItem',
          isTask ? { checked: item.checked === true } : {},
        );
        writeRuns(node(children, 'paragraph'), item.runs);

        for (const child of item.children) writeBlock(children, child);
      }
    }
  }
}

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

const kindOf = (marker: string, content: string): ListKind =>
  /\d/.test(marker)
    ? 'orderedList'
    : TASK.test(content)
      ? 'taskList'
      : 'bulletList';

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);

    if (fence) {
      const body: string[] = [];
      i++;

      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);

      i++; // the closing fence
      blocks.push({
        type: 'codeBlock',
        language: fence[1] || null,
        text: body.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        runs: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];

      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      }

      blocks.push({ type: 'blockquote', children: parseBlocks(quoted) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const listLines: string[] = [];

      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        (LIST_ITEM.test(lines[i]) || /^\s+\S/.test(lines[i]))
      ) {
        listLines.push(lines[i++]);
      }

      blocks.push(...parseLists(listLines));
      continue;
    }

    blocks.push({ type: 'paragraph', runs: parseInline(line.trim()) });
    i++;
  }

  return blocks;
}

/** Items at the shallowest indent become a list; deeper lines nest in them. */
function parseLists(lines: string[]): Block[] {
  const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
  const base = Math.min(...lines.map(indentOf));
  const blocks: Block[] = [];
  let current: { kind: ListKind; items: Item[] } | undefined;
  let nested: string[] = [];

  const flushNested = () => {
    if (current && nested.length > 0) {
      current.items[current.items.length - 1].children.push(
        ...parseLists(nested),
      );
    }

    nested = [];
  };

  for (const line of lines) {
    const match = LIST_ITEM.exec(line);

    if (match && indentOf(line) === base) {
      flushNested();
      const [, , marker, content] = match;
      const kind = kindOf(marker, content);

      if (!current || current.kind !== kind) {
        current = { kind, items: [] };
        blocks.push({ type: 'list', kind, items: current.items });
      }

      const task = kind === 'taskList' ? TASK.exec(content) : null;
      current.items.push({
        checked: task ? task[1] !== ' ' : undefined,
        runs: parseInline(task ? task[2] : content),
        children: [],
      });
    } else {
      nested.push(line);
    }
  }

  flushNested();

  return blocks;
}

function parseInline(text: string, marks: Marks = {}): Run[] {
  const runs: Run[] = [];
  let literal = '';

  const flush = () => {
    if (literal) runs.push({ text: literal, marks });

    literal = '';
  };

  const wrapped = (
    delimiter: string,
    at: number,
    mark: Marks,
  ): number | undefined => {
    const end = text.indexOf(delimiter, at + delimiter.length);

    if (end <= at + delimiter.length) return undefined;

    flush();
    runs.push(
      ...parseInline(text.slice(at + delimiter.length, end), {
        ...marks,
        ...mark,
      }),
    );

    return end + delimiter.length;
  };

  let i = 0;

  while (i < text.length) {
    const char = text[i];
    let next: number | undefined;

    if (char === '\\' && i + 1 < text.length) {
      literal += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      const end = text.indexOf('`', i + 1);

      if (end > i + 1) {
        flush();
        runs.push({
          text: text.slice(i + 1, end),
          marks: { ...marks, code: {} },
        });
        next = end + 1;
      }
    } else if (text.startsWith('**', i)) {
      next = wrapped('**', i, { bold: {} });
    } else if (text.startsWith('~~', i)) {
      next = wrapped('~~', i, { strike: {} });
    } else if (char === '*' || (char === '_' && isWordStart(text, i))) {
      next = wrapped(char, i, { italic: {} });
    } else if (char === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));

      if (link) {
        flush();
        runs.push(
          ...parseInline(link[1], { ...marks, link: { href: link[2] } }),
        );
        next = i + link[0].length;
      }
    }

    if (next === undefined) {
      literal += char;
      i++;
    } else {
      i = next;
    }
  }

  flush();

  return runs;
}

/** `snake_case` words must not turn into italics. */
const isWordStart = (text: string, i: number) =>
  i === 0 || !/\w/.test(text[i - 1]);
