import searchViewHtml from './runtime/search-view.html?raw';
import websiteRuntime from './runtime/website-runtime.min.js?raw';
// @wc-ignore-file
import { core, dataBrowser, type Resource, type Store } from '@tomic/lib';
import {
  assertPrivateWebsiteParent,
  saveWebsiteResource,
  readWebsite,
  websiteConfigSchema,
  type WebsiteConfig,
} from './websiteModel';
import {
  renderDocument,
  renderIntro,
  escapeHtml,
  renderRows,
  renderWebsitePage,
  type WebsiteArtifact,
} from './renderWebsite';

export function selectedSubjects(config: WebsiteConfig): string[] {
  return [
    ...new Set(
      config.pages.flatMap(page => [
        ...page.documents,
        ...page.tables.flatMap(table => [table.table, ...table.rows]),
      ]),
    ),
  ];
}
export async function artifactDigest(
  files: Record<string, string>,
): Promise<string> {
  const canonical = JSON.stringify(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > 5_000_000)
    throw new Error('This pilot supports exports up to 5 MB.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Snapshot only explicit content, with no relationship traversal or live queries. */
export async function buildWebsiteArtifact(
  store: Store,
  project: string,
  raw: WebsiteConfig,
): Promise<WebsiteArtifact> {
  const config = websiteConfigSchema.parse(raw);
  const resources = await Promise.all(
    selectedSubjects(config).map(async subject => {
      const resource = await store.getResource(subject);
      if (resource.error || resource.loading)
        throw new Error(`Cannot read selected content: ${subject}`);

      return resource;
    }),
  );
  const bySubject = new Map(
    resources.map(resource => [resource.subject, resource]),
  );
  // Load the editor adapter before synchronously capturing the whole selection.
  const { readDocumentV2TiptapJson } =
    await import('../RTE/readDocumentV2TiptapJson');
  const files: Record<string, string> = {};

  for (const page of config.pages) {
    const documents = page.documents.map(subject => {
      const resource = bySubject.get(subject)!;
      const result = readDocumentV2TiptapJson(resource, store);
      if (!result.ok) throw new Error(`${resource.title}: ${result.error}`);

      return `<article>${renderDocument(result.docJson as Parameters<typeof renderDocument>[0])}</article>`;
    });
    const tables = page.tables.map((table, tableIndex) => {
      const source = bySubject.get(table.table)!;
      if (!source.hasClasses(dataBrowser.classes.table))
        throw new Error('Selected table is not an Atomic table.');
      const rows = table.rows.map(subject => {
        const resource = bySubject.get(subject)!;
        if (resource.get(core.properties.parent) !== table.table)
          throw new Error('A selected row does not belong to its table.');

        return table.columns.map(column => {
          const value = resource.get(column.property);
          if (value === undefined || value === null) return '';
          if (!['string', 'number', 'boolean'].includes(typeof value))
            throw new Error(
              `Choose a scalar field for ${column.label}; relationships need an explicit export mapping.`,
            );

          return String(value);
        });
      });

      const rendered = renderRows(table, rows, tableIndex);
      if (!table.search) return rendered;
      const id = `snapshot-${tableIndex}`;
      const snapshot = JSON.stringify({
        title: table.title,
        columns: table.columns.map(c => c.label),
        rows,
      }).replace(/</g, '\\u003c');

      return (
        rendered +
        `<iframe class="snapshot-view" title="Search ${escapeHtml(table.title)}" sandbox="allow-scripts" data-snapshot="${id}" data-src="search-view.html"></iframe><script id="${id}" type="application/json">${snapshot}</script>`
      );
    });
    const filename = `${page.path.slice(1)}index.html`;
    const body = page.sections
      ? `<div class="page-layout">${page.sections
          .map(section => {
            const content =
              section.kind === 'intro'
                ? renderIntro(config, page)
                : section.kind === 'document'
                  ? documents[section.index]
                  : tables[section.index];

            return `<div class="span-${section.span} ${section.className}">${content}</div>`;
          })
          .join('')}</div>`
      : documents.join('') + tables.join('');
    let html = renderWebsitePage(config, page, body);

    if (page.tables.some(table => table.search)) {
      files['search-view.html'] = searchViewHtml;
      files['website-runtime.js'] = websiteRuntime;
      html = html.replace(
        '</body>',
        '<script src="website-runtime.js" defer></script></body>',
      );
    }

    files[filename] = html;
  }

  // No further source reads after this point: later edits cannot alter this artifact.
  const digest = await artifactDigest(files);

  return {
    version: 1,
    renderer: 'atomic-static-v1',
    project,
    config,
    files,
    digest,
    createdAt: new Date().toISOString(),
  };
}

/** Stores a PRIVATE export. Public activation belongs to the hosting API. */
export async function saveWebsiteRelease(
  store: Store,
  drive: string,
  resource: Resource,
  artifact: WebsiteArtifact,
) {
  await assertPrivateWebsiteParent(store, resource.subject);
  const agent = store.getAgent();
  if (!agent || !(await resource.canWrite(agent.subject)))
    throw new Error('You cannot create a release for this website.');
  if (
    artifact.project !== resource.subject ||
    (await artifactDigest(artifact.files)) !== artifact.digest
  )
    throw new Error('Release does not match the reviewed website artifact.');
  const { schema } = await readWebsite(store, drive, resource);
  const release = await store.newResource({
    parent: resource.subject,
    isA: [schema.classes!['website-export']],
    propVals: {
      [core.properties.name]: `Website release ${artifact.createdAt}`,
      [schema.properties!['website-artifact']]: JSON.stringify(artifact),
    },
  });
  await saveWebsiteResource(release);
  await resource.set(schema.properties!['website-release'], release.subject);
  await saveWebsiteResource(resource);

  return release;
}
export async function readWebsiteRelease(
  store: Store,
  drive: string,
  resource: Resource,
): Promise<WebsiteArtifact | undefined> {
  const { schema } = await readWebsite(store, drive, resource);
  const subject = resource.get(schema.properties!['website-release']);
  if (typeof subject !== 'string') return undefined;
  const release = await store.getResource(subject);
  const artifact = JSON.parse(
    String(release.get(schema.properties!['website-artifact'])),
  ) as WebsiteArtifact;
  if (
    artifact.version !== 1 ||
    artifact.renderer !== 'atomic-static-v1' ||
    artifact.project !== resource.subject ||
    !artifact.files ||
    (await artifactDigest(artifact.files)) !== artifact.digest
  )
    throw new Error('Stored website release failed integrity validation.');
  websiteConfigSchema.parse(artifact.config);
  if (
    Object.keys(artifact.files).some(
      name =>
        !['search-view.html', 'website-runtime.js'].includes(name) &&
        !/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*index\.html$/.test(name),
    )
  )
    throw new Error('Stored website release has an invalid file path.');

  return artifact;
}
export async function downloadWebsite(artifact: WebsiteArtifact) {
  const { ZipWriter, BlobWriter, TextReader } = await import('@zip.js/zip.js');
  const zip = new ZipWriter(new BlobWriter('application/zip'), {
    useWebWorkers: false,
  });
  for (const [path, html] of Object.entries(artifact.files))
    await zip.add(path, new TextReader(html));
  // Only public files and content hashes go into the archive; no private resource IDs/config.
  await zip.add(
    'atomic-hosting.json',
    new TextReader(
      JSON.stringify(
        {
          version: 1,
          renderer: artifact.renderer,
          digest: artifact.digest,
          files: Object.keys(artifact.files),
        },
        null,
        2,
      ),
    ),
  );
  const blob = await zip.close();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'website.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
