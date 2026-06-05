import type { JSONContent } from '@tiptap/core';

const SELF_CLOSING_NODE_TYPES = new Set([
  'atomic-data-resource',
  'atomic-data-resource-inline',
  'hardBreak',
  'horizontalRule',
  'image',
]);

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAttrs(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) {
    return '';
  }

  const parts = Object.entries(attrs)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`);

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function serializeTextNode(node: JSONContent): string {
  let text = escapeXml(node.text ?? '');

  for (const mark of node.marks ?? []) {
    const markType = mark.type ?? 'mark';

    text = `<${markType}${formatAttrs(mark.attrs as Record<string, unknown>)}>${text}</${markType}>`;
  }

  return text;
}

function isInlineOnlyContent(content: JSONContent[]): boolean {
  return content.every(child => child.type === 'text');
}

function serializeNode(node: JSONContent, indent: number): string {
  if (node.type === 'text') {
    return serializeTextNode(node);
  }

  const type = node.type ?? 'unknown';
  const pad = '  '.repeat(indent);
  const attrs = formatAttrs(node.attrs as Record<string, unknown> | undefined);
  const content = node.content ?? [];

  if (SELF_CLOSING_NODE_TYPES.has(type)) {
    return `${pad}<${type}${attrs}/>`;
  }

  if (content.length === 0) {
    return `${pad}<${type}${attrs}></${type}>`;
  }

  if (isInlineOnlyContent(content)) {
    const inner = content.map(child => serializeTextNode(child)).join('');

    return `${pad}<${type}${attrs}>${inner}</${type}>`;
  }

  const childIndent = indent + 1;
  const children = content
    .map(child => serializeNode(child, childIndent))
    .join('\n');

  return `${pad}<${type}${attrs}>\n${children}\n${pad}</${type}>`;
}

/**
 * Serialize a Tiptap document JSON tree to TipTap XML for AI agents.
 * Serializes children of the root `doc` node only (no `<doc>` wrapper).
 */
export function tiptapJsonToAgentXml(docJson: JSONContent): string {
  if (docJson.type === 'doc') {
    if (!docJson.content?.length) {
      return '';
    }

    return docJson.content.map(child => serializeNode(child, 0)).join('\n');
  }

  return serializeNode(docJson, 0);
}
