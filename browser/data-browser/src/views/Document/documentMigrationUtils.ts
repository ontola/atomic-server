import type { JSONContent } from '@tiptap/core';
import { decodeB64 } from '@tomic/lib';
import type { LoroDoc } from 'loro-crdt';

/**
 * JSON-AD shape used while Yjs was a first-class value (`{ type: 'ydoc', data }`),
 * plus the Unsupported leftover the Rust v2→v3 migrator emits for `ValueV2::YDoc`.
 *
 * Does not treat bare strings or `Uint8Array` as Yjs — those collide with
 * `lorodoc` property values. Call {@link isYjsMigrationCandidate} when the
 * Loro body is empty and a looser check is warranted.
 */
export function isSerializedYDoc(value: unknown): boolean {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) {
    return false;
  }

  const rec = value as Record<string, unknown>;

  if (rec.type === 'ydoc' && typeof rec.data === 'string') {
    return true;
  }

  return typeof rec.datatype === 'string' && rec.datatype.includes('ydoc');
}

/**
 * True when `documentContent` might still hold a Yjs update and we should
 * lazy-load `yjs` to find out. Bare strings / bytes are only candidates
 * when the Loro `doc` map is still empty, so a live Loro-backed V2 is never
 * delayed by this check.
 */
export function isYjsMigrationCandidate(
  value: unknown,
  loroBodyEmpty: boolean,
): boolean {
  if (isSerializedYDoc(value)) {
    return true;
  }

  if (!loroBodyEmpty) {
    return false;
  }

  if (value instanceof Uint8Array) {
    return value.byteLength > 0;
  }

  return typeof value === 'string' && value.length > 32;
}

export function extractYDocBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value.byteLength > 0 ? value : undefined;
  }

  if (typeof value === 'string' && value.length > 0) {
    try {
      const bytes = decodeB64(value);

      return bytes.byteLength > 0 ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const rec = value as Record<string, unknown>;

  if (rec.type === 'ydoc' && typeof rec.data === 'string') {
    try {
      return decodeB64(rec.data);
    } catch {
      return undefined;
    }
  }

  if (
    typeof rec.datatype === 'string' &&
    rec.datatype.includes('ydoc') &&
    typeof rec.value === 'string'
  ) {
    try {
      const nested = JSON.parse(rec.value) as unknown;

      if (isSerializedYDoc(nested)) {
        return extractYDocBytes(nested);
      }

      return decodeB64(rec.value);
    } catch {
      try {
        return decodeB64(rec.value);
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function loroDocBodyIsEmpty(loroDoc: LoroDoc): boolean {
  try {
    const nodeName = loroDoc.getMap('doc').get('nodeName');

    return nodeName === null || nodeName === undefined;
  } catch {
    return true;
  }
}

export function tiptapJsonHasVisibleContent(doc: JSONContent): boolean {
  const walk = (node: JSONContent | undefined): boolean => {
    if (!node) {
      return false;
    }

    if (typeof node.text === 'string' && node.text.length > 0) {
      return true;
    }

    if (node.type === 'atomic-data-resource' && node.attrs?.subject) {
      return true;
    }

    if (node.type === 'image' && node.attrs?.src) {
      return true;
    }

    return (node.content ?? []).some(walk);
  };

  return walk(doc);
}

export const RESOURCE_EMBED_TYPE = 'atomic-data-resource';

/** True when the Loro `doc` map already has user-visible body (text / embed). */
export function loroDocHasVisibleContent(loroDoc: LoroDoc): boolean {
  if (loroDocBodyIsEmpty(loroDoc)) {
    return false;
  }

  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') {
      return false;
    }

    const rec = node as Record<string, unknown>;

    if (typeof rec.text === 'string' && rec.text.length > 0) {
      return true;
    }

    if (
      rec.nodeName === RESOURCE_EMBED_TYPE ||
      rec.type === RESOURCE_EMBED_TYPE
    ) {
      return true;
    }

    if (Array.isArray(rec.content)) {
      return rec.content.some(walk);
    }

    return false;
  };

  try {
    return walk(loroDoc.getMap('doc').toJSON());
  } catch {
    return false;
  }
}

export function resourceEmbedNode(subject: string): JSONContent {
  return {
    type: RESOURCE_EMBED_TYPE,
    attrs: { subject },
  };
}

export function emptyTiptapDoc(): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
}

export function wrapTiptapContent(content: JSONContent[]): JSONContent {
  if (content.length === 0) {
    return emptyTiptapDoc();
  }

  return { type: 'doc', content };
}

type YXmlDelta = {
  insert?: string | unknown;
  attributes?: Record<string, unknown>;
};

type YXmlTextLike = {
  toDelta: () => YXmlDelta[];
};

type YXmlElementLike = {
  nodeName: string;
  getAttributes: () => Record<string, unknown>;
  toArray: () => unknown[];
};

function isXmlText(node: unknown): node is YXmlTextLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as YXmlTextLike).toDelta === 'function' &&
    typeof (node as YXmlElementLike).nodeName !== 'string'
  );
}

function isXmlElement(node: unknown): node is YXmlElementLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as YXmlElementLike).nodeName === 'string' &&
    typeof (node as YXmlElementLike).toArray === 'function'
  );
}

function coerceAttrValue(value: unknown): unknown {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }

  return value;
}

function coerceAttrs(
  attrs: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) {
      continue;
    }

    out[key] = coerceAttrValue(value);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function marksFromDeltaAttrs(
  attrs: Record<string, unknown> | undefined,
): JSONContent['marks'] {
  if (!attrs) {
    return undefined;
  }

  const marks: NonNullable<JSONContent['marks']> = [];

  for (const [type, value] of Object.entries(attrs)) {
    if (value === false || value === undefined || value === null) {
      continue;
    }

    if (value === true || value === 1) {
      marks.push({ type });
      continue;
    }

    if (typeof value === 'string') {
      marks.push(
        type === 'link'
          ? { type, attrs: { href: value } }
          : { type, attrs: { [type]: value } },
      );
      continue;
    }

    if (typeof value === 'object') {
      marks.push({ type, attrs: value as Record<string, unknown> });
    }
  }

  return marks.length > 0 ? marks : undefined;
}

function textNodesFromDelta(delta: YXmlDelta[]): JSONContent[] {
  const nodes: JSONContent[] = [];

  for (const item of delta) {
    if (typeof item.insert !== 'string' || item.insert.length === 0) {
      continue;
    }

    const marks = marksFromDeltaAttrs(item.attributes);
    const node: JSONContent = { type: 'text', text: item.insert };

    if (marks) {
      node.marks = marks;
    }

    nodes.push(node);
  }

  return nodes;
}

function xmlElementToNode(element: YXmlElementLike): JSONContent {
  const content: JSONContent[] = [];

  for (const child of element.toArray()) {
    if (isXmlText(child)) {
      content.push(...textNodesFromDelta(child.toDelta()));
    } else if (isXmlElement(child)) {
      content.push(xmlElementToNode(child));
    }
  }

  const node: JSONContent = { type: element.nodeName };
  const attrs = coerceAttrs(element.getAttributes() ?? {});

  if (attrs) {
    node.attrs = attrs;
  }

  if (content.length > 0) {
    node.content = content;
  }

  return node;
}

/**
 * Walk a y-prosemirror / y-tiptap `XmlFragment` (`content`) into TipTap JSON
 * without loading `@tiptap/y-tiptap`.
 */
export function yjsXmlFragmentToTiptapJSON(fragment: {
  toArray: () => unknown[];
}): JSONContent {
  const content: JSONContent[] = [];

  for (const child of fragment.toArray()) {
    if (isXmlElement(child)) {
      content.push(xmlElementToNode(child));
    } else if (isXmlText(child)) {
      content.push({
        type: 'paragraph',
        content: textNodesFromDelta(child.toDelta()),
      });
    }
  }

  return wrapTiptapContent(content);
}
