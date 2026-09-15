// @wc-ignore-file
import type { WebsiteConfig } from './websiteModel';

export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
}
export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    char =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );

/** Closed export vocabulary: unknown Atomic embeds fail instead of reading more data. */
export function renderDocument(node: RichNode, depth = 0): string {
  if (depth > 80) throw new Error('Document nesting exceeds the export limit.');
  const inner = () =>
    (node.content ?? []).map(n => renderDocument(n, depth + 1)).join('');

  if (node.type === 'text') {
    let text = escapeHtml(node.text ?? '');

    for (const mark of node.marks ?? []) {
      const tag = (
        {
          bold: 'strong',
          italic: 'em',
          strike: 's',
          code: 'code',
          underline: 'u',
        } as Record<string, string>
      )[mark.type];
      if (tag) text = `<${tag}>${text}</${tag}>`;
      else if (mark.type === 'link') {
        const href = String(mark.attrs?.href ?? '');
        if (!/^(https?:\/\/|mailto:|#)/i.test(href))
          throw new Error(
            'Unsupported document link. Use a public HTTPS link.',
          );
        text = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
      } else if (mark.type !== 'textStyle')
        throw new Error(`Unsupported text formatting: ${mark.type}`);
    }

    return text;
  }

  if (node.type === 'doc') return inner();
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'horizontalRule') return '<hr>';

  if (node.type === 'heading') {
    const level = Number(node.attrs?.level);
    if (!Number.isInteger(level) || level < 1 || level > 6)
      throw new Error('Invalid heading level.');

    return `<h${level}>${inner()}</h${level}>`;
  }

  if (node.type === 'image') {
    const src = String(node.attrs?.src ?? '');
    // No live private media URLs in a supposedly self-contained release.
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src))
      throw new Error(
        'Image export requires an embedded PNG, JPEG, WebP or GIF. Private media packaging is not implemented yet.',
      );

    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(String(node.attrs?.alt ?? ''))}">`;
  }

  const tag = (
    {
      paragraph: 'p',
      bulletList: 'ul',
      orderedList: 'ol',
      listItem: 'li',
      blockquote: 'blockquote',
      codeBlock: 'pre',
      table: 'table',
      tableRow: 'tr',
      tableHeader: 'th',
      tableCell: 'td',
      taskList: 'ul',
      taskItem: 'li',
      'note-block': 'aside',
    } as Record<string, string>
  )[node.type];
  if (!tag)
    throw new Error(
      `Cannot export ${node.type}. Select its public content explicitly instead of embedding a live resource.`,
    );
  const checked =
    node.type === 'taskItem' ? `${node.attrs?.checked ? '☑' : '☐'} ` : '';

  return `<${tag}>${checked}${inner()}</${tag}>`;
}

export interface ResolvedPage {
  path: string;
  body: string;
}
export interface WebsiteArtifact {
  version: 1;
  renderer: 'atomic-static-v1';
  project: string;
  config: WebsiteConfig;
  files: Record<string, string>;
  digest: string;
  createdAt: string;
}
export function renderIntro(
  config: WebsiteConfig,
  page: WebsiteConfig['pages'][number],
) {
  return `<section class="intro"><p class="eyebrow">${escapeHtml(config.title)}</p><h1>${escapeHtml(page.path === '/' ? config.title : page.title)}</h1><p>${escapeHtml(config.description)}</p></section>`;
}
export function renderWebsitePage(
  config: WebsiteConfig,
  page: WebsiteConfig['pages'][number],
  body: string,
) {
  const navigation = config.pages
    .map(
      p =>
        `<a href="${p.path === '/' ? 'index.html' : `${p.path.slice(1)}index.html`}"${p.path === page.path ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`,
    )
    .join('');
  const base =
    page.path === '/'
      ? './'
      : '../'.repeat(page.path.split('/').filter(Boolean).length);

  return `<!doctype html>
<html lang="${escapeHtml(config.language)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'self'; form-action 'none'">
<base href="${base}"><title>${escapeHtml(page.title)} · ${escapeHtml(config.title)}</title>
<meta name="description" content="${escapeHtml(config.description)}">
<style>
:root{--accent:${config.accent};--paper:${config.background};color:#202721;background:var(--paper);font-family:${config.font === 'serif' ? "Georgia,'Times New Roman',serif" : 'system-ui,sans-serif'};line-height:1.7;font-size:18px}
*{box-sizing:border-box}body{margin:0}a{color:var(--accent);text-underline-offset:.2em}header,main,footer{width:min(1100px,90%);margin:auto}header{padding:2rem 0;border-bottom:1px solid #0002;display:flex;gap:2rem;justify-content:space-between;align-items:center}.brand{font-size:1.35rem;font-weight:bold;text-decoration:none}nav{display:flex;gap:1.5rem;flex-wrap:wrap}nav a{text-decoration:none;font: .85rem system-ui}nav a[aria-current]{border-bottom:2px solid var(--accent)}main{padding:4rem 0 6rem}.intro{max-width:800px;margin-bottom:4rem}.eyebrow{font:.75rem system-ui;text-transform:uppercase;letter-spacing:.2em;color:var(--accent)}h1{font-size:clamp(2.8rem,7vw,5.5rem);line-height:1.05;letter-spacing:-.04em;margin:.5em 0}h2{font-size:2rem;line-height:1.2}h3{font-size:1.4rem}article{max-width:760px;margin:0 0 4rem}article p{max-width:68ch}img{max-width:100%;height:auto;border-radius:8px}blockquote,aside{border-left:3px solid var(--accent);padding:.5rem 1.5rem;background:#00000005}pre{overflow:auto;padding:1rem;background:#00000009}table{width:100%;border-collapse:collapse;font:.9rem system-ui}th,td{text-align:left;padding:1rem;border-bottom:1px solid #0002;vertical-align:top}.table-wrap{overflow:auto}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:1.25rem}.card{border:1px solid #0002;border-radius:12px;padding:1.5rem;background:#ffffff70}.card dt{font:.7rem system-ui;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-top:1rem}.card dd{margin:0;white-space:pre-wrap}footer{padding:2rem 0;border-top:1px solid #0002;font:.8rem system-ui}.empty{color:#687168}@media(max-width:600px){header{align-items:flex-start;flex-direction:column}main{padding-top:2rem}}
.page-layout{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2rem}.span-full{grid-column:span 6}.span-half{grid-column:span 3}.span-third{grid-column:span 2}.snapshot-view{width:100%;height:430px;border:0;border-radius:12px}.page-layout article{max-width:none}@media(max-width:760px){.span-half,.span-third{grid-column:span 6}}
${config.css}
</style></head><body><header><a class="brand" href="index.html">${escapeHtml(config.title)}</a><nav aria-label="Pages">${navigation}</nav></header>
<main>${page.sections ? body : renderIntro(config, page) + body}</main>
<footer>${escapeHtml(config.title)}</footer></body></html>`;
}
export function renderRows(
  table: WebsiteConfig['pages'][number]['tables'][number],
  rows: (string | { src: string; alt: string })[][],
  tableIndex = 0,
) {
  const cell = (value: string | { src: string; alt: string }) =>
    typeof value === 'string'
      ? escapeHtml(value)
      : renderDocument({ type: 'image', attrs: value });
  const content =
    table.layout === 'grid'
      ? `<div class="cards">${rows.map(row => `<dl class="card">${table.columns.map((c, i) => `<dt>${escapeHtml(c.label)}</dt><dd>${cell(row[i])}</dd>`).join('')}</dl>`).join('')}</div>`
      : `<div class="table-wrap"><table><thead><tr>${table.columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${cell(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  return `<section data-website-table="${tableIndex}"><h2>${escapeHtml(table.title)}</h2>${content}</section>`;
}
