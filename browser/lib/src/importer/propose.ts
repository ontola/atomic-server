import { core } from '../ontologies/core.js';
import { dataBrowser } from '../ontologies/dataBrowser.js';
import type { JSONValue } from '../value.js';
import {
  extractPageData,
  htmlToText,
  looksLikeHtml,
  type JsonLdNode,
  type PageData,
} from './extract.js';

/** What the user (or, later, a browser extension) hands over. */
export interface ImportCapture {
  url?: string;
  title?: string;
  html?: string;
  text?: string;
  selection?: string;
}

export interface ImportProposal {
  /** An existing class. The importer never creates schema. */
  class: string;
  propvals: Record<string, JSONValue>;
  /** Canonical source URL, when the capture had one. */
  sourceUrl?: string;
  /** Why this proposal looks the way it does, for the UI to say out loud. */
  detected: {
    source: 'json-ld' | 'opengraph' | 'page' | 'text' | 'url';
    /** The schema.org type that was found, whether or not a class fits it. */
    schemaType?: string;
  };
}

const ARTICLE_TYPES = new Set([
  'Article',
  'NewsArticle',
  'BlogPosting',
  'Report',
  'TechArticle',
  'ScholarlyArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  'AnalysisNewsArticle',
  'LiveBlogPosting',
]);

/** Page-level types that describe the document, not the thing it is about. */
const WRAPPER_TYPES = new Set([
  'WebSite',
  'WebPage',
  'CollectionPage',
  'ItemPage',
  'AboutPage',
  'ProfilePage',
  'BreadcrumbList',
  'ListItem',
  'SearchAction',
  'ImageObject',
  'VideoObject',
  'SiteNavigationElement',
  'WPHeader',
  'WPFooter',
  'Organization',
  'Person',
  'Thing',
]);

const MAX_PREVIEW = 20_000;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i;

function typesOf(node: JsonLdNode): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];

  return list
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.replace(/^.*[/#]/, ''));
}

/** A value of any JSON-LD shape as one line of text. */
function textOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return htmlToText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(', ');

  const o = v as JsonLdNode;

  if (o['@type'] === 'PostalAddress') {
    return [o.streetAddress, o.postalCode, o.addressLocality, o.addressCountry]
      .map(textOf)
      .filter(Boolean)
      .join(', ');
  }

  if (typeof o.text === 'string') return htmlToText(o.text);

  const label = textOf(o.name) || textOf(o.url) || textOf(o['@id']);
  const address = textOf(o.address);

  return address && label ? `${label}, ${address}` : label || address;
}

/** `PT1H30M` as `1 h 30 min`. Anything else is returned as given. */
function duration(v: string): string {
  const m = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(v);

  if (!m || (!m[1] && !m[2])) return v;

  return [m[1] && `${m[1]} h`, m[2] && `${m[2]} min`].filter(Boolean).join(' ');
}

function imageOf(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  const url =
    typeof first === 'string'
      ? first
      : textOf((first as JsonLdNode | undefined)?.url);

  return /^https?:\/\//i.test(url) ? url : undefined;
}

function steps(v: unknown): string[] {
  if (typeof v === 'string') return [htmlToText(v)];
  if (!Array.isArray(v)) return v ? steps([v]) : [];

  return v.flatMap(step => {
    const s = step as JsonLdNode;

    return Array.isArray(s.itemListElement)
      ? steps(s.itemListElement)
      : [textOf(s)];
  });
}

const FIELDS: Record<string, Array<[string, string]>> = {
  Recipe: [
    ['Prep time', 'prepTime'],
    ['Cook time', 'cookTime'],
    ['Total time', 'totalTime'],
    ['Yield', 'recipeYield'],
  ],
  Event: [
    ['Starts', 'startDate'],
    ['Ends', 'endDate'],
    ['Where', 'location'],
    ['Organizer', 'organizer'],
    ['Status', 'eventStatus'],
  ],
  Product: [
    ['Brand', 'brand'],
    ['SKU', 'sku'],
  ],
};

/** A markdown digest of the facts on a schema.org node. */
function digest(node: JsonLdNode, type: string): string {
  const lines: string[] = [`Type: ${type}`];

  for (const [label, key] of FIELDS[type] ?? []) {
    const value = textOf(node[key]);

    if (value) {
      lines.push(`${label}: ${/time$/i.test(key) ? duration(value) : value}`);
    }
  }

  const offers = [node.offers].flat()[0] as JsonLdNode | undefined;

  if (offers?.price !== undefined) {
    lines.push(
      `Price: ${[textOf(offers.priceCurrency), textOf(offers.price)]
        .filter(Boolean)
        .join(' ')}`,
    );
  }

  let out = lines.map(l => `- ${l}`).join('\n');
  const ingredients = [node.recipeIngredient]
    .flat()
    .map(textOf)
    .filter(Boolean);

  if (ingredients.length) {
    out += `\n\n## Ingredients\n\n${ingredients.map(i => `- ${i}`).join('\n')}`;
  }

  const how = steps(node.recipeInstructions).filter(Boolean);

  if (how.length) {
    out += `\n\n## Steps\n\n${how.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }

  return out.slice(0, MAX_PREVIEW);
}

/** Calendar dates only: the `date` datatype is `YYYY-MM-DD`. */
function isoDate(v: unknown): string | undefined {
  return typeof v === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0] : undefined;
}

/**
 * The URL that identifies the page: without fragment, tracking parameters or
 * a trailing slash. Returns undefined for anything but http(s).
 */
export function canonicalSourceUrl(url?: string): string | undefined {
  if (!url) return undefined;

  let u: URL;

  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;

  u.hash = '';

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }

  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');

  return u.toString();
}

/** The shared import identity (`localId`) of a page. */
export function importLocalId(sourceUrl: string): string {
  return `import:url:${sourceUrl}`;
}

/** Picks the entity the page is about out of a flat list of JSON-LD nodes. */
export function mainEntity(nodes: JsonLdNode[]): JsonLdNode | undefined {
  const refs = new Set<string>();

  for (const n of nodes) {
    for (const ref of [n.mainEntity, n.mainEntityOfPage].flat()) {
      const id = (ref as JsonLdNode | undefined)?.['@id'];

      if (typeof id === 'string') refs.add(id);
    }
  }

  const nested = nodes.flatMap(n =>
    [n.mainEntity].flat().filter(m => typeof m === 'object' && m !== null),
  ) as JsonLdNode[];

  const score = (n: JsonLdNode): number => {
    const types = typesOf(n);
    const useful = types.some(t => !WRAPPER_TYPES.has(t));
    const id = n['@id'];

    return (
      (typeof id === 'string' && refs.has(id) ? 100 : 0) +
      (nested.includes(n) ? 100 : 0) +
      (useful ? 10 : 0) +
      Math.min(Object.keys(n).length, 9) / 10
    );
  };

  const candidates = [...nodes, ...nested].filter(
    n => typesOf(n).length > 0 && typesOf(n).some(t => !WRAPPER_TYPES.has(t)),
  );

  return candidates.sort((a, b) => score(b) - score(a))[0];
}

function bookmark(
  data: PageData,
  sourceUrl: string | undefined,
  fields: {
    name?: string;
    description?: string;
    image?: string;
    preview?: string;
  },
  detected: ImportProposal['detected'],
): ImportProposal {
  const propvals: Record<string, JSONValue> = {
    [core.properties.name]: fields.name || data.title || sourceUrl || 'Page',
  };

  if (sourceUrl) propvals[dataBrowser.properties.url] = sourceUrl;

  if (fields.description)
    propvals[core.properties.description] = fields.description;

  if (fields.image) propvals[dataBrowser.properties.imageUrl] = fields.image;
  if (fields.preview) propvals[dataBrowser.properties.preview] = fields.preview;

  return {
    class: dataBrowser.classes.bookmark,
    propvals: withIdentity(propvals, sourceUrl),
    sourceUrl,
    detected,
  };
}

function withIdentity(
  propvals: Record<string, JSONValue>,
  sourceUrl: string | undefined,
): Record<string, JSONValue> {
  if (sourceUrl) propvals[core.properties.localId] = importLocalId(sourceUrl);

  return propvals;
}

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';

  return line
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 120);
}

/**
 * Turns captured input into one proposal for an existing class. Pure: nothing
 * is fetched or written. Returns undefined when there is nothing to import.
 */
export function proposeImport(
  capture: ImportCapture,
): ImportProposal | undefined {
  const pasted = capture.text?.trim();
  const html =
    capture.html?.trim() || (pasted && looksLikeHtml(pasted) ? pasted : '');
  const selection = capture.selection?.trim();
  const text = html ? undefined : pasted;
  const data = extractPageData(html || '');
  const url = capture.url?.trim() || data.canonical || data.meta['og:url'];
  const sourceUrl = canonicalSourceUrl(url);
  const og = (k: string) => data.meta[`og:${k}`];
  const description =
    og('description') ||
    data.meta.description ||
    data.meta['twitter:description'];
  const image = imageOf(og('image') ?? data.meta['twitter:image']);

  // 1. Structured data: JSON-LD first.
  const node = mainEntity(data.jsonLd);

  if (node) {
    const types = typesOf(node);
    const article = types.find(t => ARTICLE_TYPES.has(t));
    const type = article ?? types.find(t => !WRAPPER_TYPES.has(t)) ?? types[0];
    const name = textOf(node.headline) || textOf(node.name) || og('title');
    const summary = textOf(node.description) || description;
    const detected = { source: 'json-ld', schemaType: type } as const;

    if (article) {
      const body =
        typeof node.articleBody === 'string'
          ? htmlToText(node.articleBody)
          : '';
      const propvals: Record<string, JSONValue> = {
        [core.properties.name]: name || data.title || 'Article',
        [core.properties.description]:
          selection || body || summary || name || '',
      };
      const published = isoDate(node.datePublished);

      if (published) propvals[dataBrowser.properties.publishedAt] = published;

      return {
        class: dataBrowser.classes.article,
        propvals: withIdentity(propvals, sourceUrl),
        sourceUrl,
        detected,
      };
    }

    // No class fits a Recipe, Event, Product and so on: keep a Bookmark that
    // carries the facts as its markdown preview.
    return bookmark(
      data,
      sourceUrl,
      {
        name,
        description: summary,
        image: imageOf(node.image) ?? image,
        preview: selection
          ? `${selection}\n\n${digest(node, type)}`
          : digest(node, type),
      },
      detected,
    );
  }

  // 2. OpenGraph and meta tags.
  if (og('title') || description) {
    return bookmark(
      data,
      sourceUrl,
      {
        name: og('title') || capture.title,
        description,
        image,
        preview: selection,
      },
      { source: 'opengraph', schemaType: og('type') },
    );
  }

  // 3. A page without any structure: title, and a taste of the visible text.
  if (html) {
    const visible = htmlToText(html);

    return bookmark(
      data,
      sourceUrl,
      {
        name: capture.title || data.title,
        description: visible.slice(0, 300),
        preview: selection,
      },
      { source: 'page' },
    );
  }

  // 4. Only text. With a URL it is that page's text; without, a note.
  const body = selection || text;

  if (body && !sourceUrl) {
    return {
      class: dataBrowser.classes.article,
      propvals: {
        [core.properties.name]: capture.title || firstLine(body) || 'Note',
        [core.properties.description]: body,
      },
      detected: { source: 'text' },
    };
  }

  if (sourceUrl) {
    return bookmark(
      data,
      sourceUrl,
      {
        name: capture.title || (body ? firstLine(body) : undefined),
        preview: body,
      },
      { source: body ? 'text' : 'url' },
    );
  }

  return undefined;
}
