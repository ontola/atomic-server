import type { LoroDoc } from 'loro-crdt';

/**
 * Reads the rich-text body of a document or meeting as Markdown-ish plain text.
 *
 * The body is a loro-prosemirror tree in the Loro map `doc`: every node is a
 * map with `nodeName`, `attributes` and `children`, and text runs are
 * `LoroText` children. Walking that tree directly needs no editor schema,
 * which lives in the data-browser and pulls in TipTap. Marks (bold, links)
 * are dropped; block structure is kept.
 */
export function documentText(doc: LoroDoc): string {
  const root = doc.getMap('doc');

  if (root.get('nodeName') === undefined) {
    return '';
  }

  const lines: string[] = [];
  walk(root.toJSON() as LoroNodeJson, lines, '');

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface LoroNodeJson {
  nodeName?: string;
  attributes?: Record<string, unknown>;
  children?: (LoroNodeJson | string)[];
}

const inlineText = (node: LoroNodeJson): string =>
  (node.children ?? [])
    .map(child => (typeof child === 'string' ? child : inlineText(child)))
    .join('');

function walk(node: LoroNodeJson, lines: string[], indent: string): void {
  const children = node.children ?? [];

  switch (node.nodeName) {
    case 'heading': {
      const level = Number(node.attributes?.level ?? 1);
      lines.push('', `${'#'.repeat(level)} ${inlineText(node)}`, '');

      return;
    }

    case 'paragraph':
      lines.push(`${indent}${inlineText(node)}`);

      return;

    case 'codeBlock':
      lines.push('```', inlineText(node), '```');

      return;

    case 'horizontalRule':
      lines.push('---');

      return;

    case 'listItem':
      listItem(node, lines, indent, '');

      return;

    case 'taskItem':
      listItem(node, lines, indent, node.attributes?.checked ? '[x] ' : '[ ] ');

      return;

    default:
      for (const child of children) {
        if (typeof child === 'string') {
          lines.push(`${indent}${child}`);
        } else {
          walk(child, lines, indent);
        }
      }
  }
}

/** The first child is the item's own line; later ones (nested lists) indent. */
function listItem(
  node: LoroNodeJson,
  lines: string[],
  indent: string,
  checkbox: string,
): void {
  const [first, ...rest] = node.children ?? [];
  const firstText =
    typeof first === 'string' ? first : first ? inlineText(first) : '';
  lines.push(`${indent}- ${checkbox}${firstText}`);

  for (const child of rest) {
    if (typeof child !== 'string') walk(child, lines, `${indent}  `);
  }
}
