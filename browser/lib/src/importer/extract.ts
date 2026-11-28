/**
 * Reads the structured data out of a page's HTML without a DOM, so it runs
 * the same in the browser, in workers and in tests.
 */

export type JsonLdNode = Record<string, unknown>;

export interface PageData {
  title?: string;
  /** `<meta>` tags by lowercase name or property, first occurrence wins. */
  meta: Record<string, string>;
  canonical?: string;
  /** Every JSON-LD object, with `@graph` and arrays flattened. */
  jsonLd: JsonLdNode[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);

      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }

    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }

  return out;
}

function flatten(value: unknown, into: JsonLdNode[]): void {
  if (Array.isArray(value)) {
    value.forEach(v => flatten(v, into));

    return;
  }

  if (typeof value !== 'object' || value === null) return;

  const node = value as JsonLdNode;

  if (Array.isArray(node['@graph'])) {
    flatten(node['@graph'], into);
    // A wrapper that only carries a context and a graph is not an entity.
    if (Object.keys(node).every(k => k === '@context' || k === '@graph'))
      return;
  }

  into.push(node);
}

export function extractPageData(html: string): PageData {
  const meta: Record<string, string> = {};
  let canonical: string | undefined;

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop)?.toLowerCase();

    if (key && a.content !== undefined && meta[key] === undefined) {
      meta[key] = a.content.trim();
    }
  }

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);

    if (a.rel?.toLowerCase() === 'canonical' && a.href) canonical = a.href;
  }

  const jsonLd: JsonLdNode[] = [];
  const scripts =
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

  for (const m of html.matchAll(scripts)) {
    try {
      flatten(JSON.parse(m[1].trim()), jsonLd);
    } catch {
      // A broken block must not hide the other blocks or the meta tags.
    }
  }

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  return {
    title: title
      ? decodeEntities(title).replace(/\s+/g, ' ').trim()
      : undefined,
    meta,
    canonical,
    jsonLd,
  };
}

/** Visible text of an HTML fragment: scripts, styles and tags removed. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether pasted text is a page's markup rather than plain text. */
export function looksLikeHtml(text: string): boolean {
  return /<(!doctype|html|head|body|meta|script|article|div|p)\b/i.test(text);
}
