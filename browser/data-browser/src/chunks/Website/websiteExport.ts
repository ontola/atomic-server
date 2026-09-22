import {
  hostingRequest,
  type HostingStatus,
  type WebsitePackage,
} from './hostingClient';
import { uploadWebsiteAssets } from './websiteAssets';
import { optimizeWebsiteImage } from './optimizeWebsiteImage';
import {
  storeWebsiteAsset,
  readWebsiteAsset,
  type WebsiteAsset,
} from './websiteAssets';
import { snapshotWebsiteImage } from './websiteMedia';
import searchViewHtml from './runtime/search-view.html?raw';
import websiteRuntime from './runtime/website-runtime.min.js?raw';
// @wc-ignore-file
import {
  core,
  dataBrowser,
  server,
  Datatype,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  assertPrivateWebsiteParent,
  readWebsite,
  findWebsiteSchema,
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
  type RichNode,
} from './renderWebsite';

export function selectedSubjects(config: WebsiteConfig): string[] {
  return [
    ...new Set(
      config.pages.flatMap(page => [
        ...page.documents,
        ...(page.media ?? []).map(image => image.subject),
        ...page.tables.flatMap(table => [table.table, ...table.rows]),
      ]),
    ),
  ];
}
export async function artifactDigest(
  files: Record<string, string>,
  assets?: Record<string, WebsiteAsset>,
): Promise<string> {
  const canonical = JSON.stringify(
    assets && Object.keys(assets).length
      ? {
          files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
          assets: Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)),
        }
      : Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
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
        throw new Error(
          `Cannot read selected content: ${resource.title === subject ? subject : `${resource.title} (${subject})`}. ${resource.error ? String(resource.error) : 'The resource is still loading.'}`,
          { cause: resource.error },
        );

      return resource;
    }),
  );
  const bySubject = new Map(
    resources.map(resource => [resource.subject, resource]),
  );
  // Load the editor adapter before synchronously capturing the whole selection.
  const documentReader = config.pages.some(page => page.documents.length)
    ? await import('../RTE/readDocumentV2TiptapJson')
    : undefined;
  const files: Record<string, string> = {};

  const assets: Record<string, WebsiteAsset> = {};
  const imageCache = new Map<string, Promise<string>>();

  const packageImage = async (blob: Blob) => {
    const asset = await storeWebsiteAsset(store, blob);
    const path = `assets/${asset.hash}.${asset.mimeType.slice('image/'.length)}`;
    assets[path] = asset;

    return `/${path}`;
  };

  const packageDocument = async (
    node: RichNode,
    depth = 0,
  ): Promise<RichNode> => {
    if (depth > 80)
      throw new Error('Document nesting exceeds the export limit.');

    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? '');
      const match =
        /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
          src,
        );
      if (!match || match[2].length > 67_000_000)
        throw new Error(
          'Document image must be a supported image under 50 MB.',
        );
      const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
      const path = await packageImage(
        await optimizeWebsiteImage(new Blob([bytes], { type: match[1] })),
      );

      return { ...node, attrs: { ...node.attrs, src: path } };
    }

    const content: RichNode[] = [];
    for (const child of node.content ?? [])
      content.push(await packageDocument(child, depth + 1));

    return { ...node, content };
  };

  let imageQueue = Promise.resolve();

  const image = async (subject: string, location: string) => {
    if (!imageCache.has(subject)) {
      const pending = imageQueue.then(async () => {
        const blob = await snapshotWebsiteImage(store, subject);

        return packageImage(blob);
      });
      imageCache.set(subject, pending);
      imageQueue = pending.then(
        () => undefined,
        () => undefined,
      );
    }

    try {
      return await imageCache.get(subject)!;
    } catch (error) {
      throw new Error(
        `${location}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  for (const [pageIndex, page] of config.pages.entries()) {
    const gallery = `<section class="gallery"><div class="cards">${(
      await Promise.all(
        (page.media ?? []).map(
          async (media, mediaIndex) =>
            `<figure>${renderDocument({ type: 'image', attrs: { src: await image(media.subject, `page[${pageIndex}] (${page.path}).media[${mediaIndex}]`), alt: media.alt } })}${media.caption ? `<figcaption>${escapeHtml(media.caption)}</figcaption>` : ''}</figure>`,
        ),
      )
    ).join('')}</div></section>`;
    const documents: string[] = [];

    for (const [documentIndex, subject] of page.documents.entries()) {
      const resource = bySubject.get(subject)!;
      const result = documentReader!.readDocumentV2TiptapJson(resource, store);
      if (!result.ok) throw new Error(`${resource.title}: ${result.error}`);

      try {
        documents.push(
          `<article data-website-document="${documentIndex}">${renderDocument(await packageDocument(result.docJson as RichNode))}</article>`,
        );
      } catch (error) {
        throw new Error(
          `page[${pageIndex}] (${page.path}).document "${resource.title}" (${subject}): ${String(error)}`,
        );
      }
    }

    const tables = await Promise.all(
      page.tables.map(async (table, tableIndex) => {
        const source = bySubject.get(table.table)!;
        if (!source.hasClasses(dataBrowser.classes.table))
          throw new Error('Selected table is not an Atomic table.');
        const imageColumns = await Promise.all(
          table.columns.map(async column => {
            const property = await store.getResource(column.property);

            return (
              property.get(core.properties.datatype) === Datatype.ATOMIC_URL &&
              property.get(core.properties.classtype) === server.classes.file
            );
          }),
        );
        const rows = await Promise.all(
          table.rows.map(async (subject, rowIndex) => {
            const resource = bySubject.get(subject)!;
            if (resource.get(core.properties.parent) !== table.table)
              throw new Error('A selected row does not belong to its table.');

            return Promise.all(
              table.columns.map(async (column, columnIndex) => {
                const value = resource.get(column.property);
                if (value === undefined || value === null) return '';
                if (imageColumns[columnIndex] && typeof value === 'string')
                  return {
                    src: await image(
                      value,
                      `page[${pageIndex}] (${page.path}).tables[${tableIndex}].rows[${rowIndex}].${column.label}`,
                    ),
                    alt: column.label,
                  };
                if (!['string', 'number', 'boolean'].includes(typeof value))
                  throw new Error(
                    `Choose a scalar field for ${column.label}; relationships need an explicit export mapping.`,
                  );

                return String(value);
              }),
            );
          }),
        );

        const rendered = renderRows(table, rows, tableIndex);
        if (!table.search) return rendered;
        const id = `snapshot-${tableIndex}`;
        const snapshot = JSON.stringify({
          title: table.title,
          columns: table.columns.map(c => c.label),
          rows: rows.map(row =>
            row.map(cell => (typeof cell === 'string' ? cell : cell.alt)),
          ),
        }).replace(/</g, '\\u003c');

        return (
          rendered +
          `<iframe class="snapshot-view" title="Search ${escapeHtml(table.title)}" sandbox="allow-scripts" data-snapshot="${id}" data-src="search-view.html"></iframe><script id="${id}" type="application/json">${snapshot}</script>`
        );
      }),
    );
    const filename = `${page.path.slice(1)}index.html`;
    const body = page.sections
      ? `<div class="page-layout">${page.sections
          .map(section => {
            const content =
              section.kind === 'intro'
                ? renderIntro(config, page)
                : section.kind === 'document'
                  ? documents[section.index]
                  : section.kind === 'gallery'
                    ? gallery
                    : tables[section.index];

            return `<div class="span-${section.span} ${section.className}">${content}</div>`;
          })
          .join('')}</div>`
      : documents.join('') +
        tables.join('') +
        (page.media?.length ? gallery : '');
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
  const digest = await artifactDigest(files, assets);

  return {
    version: 1,
    renderer: 'atomic-static-v1',
    project,
    config,
    files,
    assets,
    digest,
    createdAt: new Date().toISOString(),
  };
}

/** Uploads a reviewed App release. Public activation belongs to the hosting API. */
export async function saveAppRelease(
  store: Store,
  resource: Resource,
  artifact: WebsiteArtifact,
) {
  await assertPrivateWebsiteParent(store, resource.subject);
  const agent = store.getAgent();
  if (!agent || !(await resource.canWrite(agent.subject)))
    throw new Error('You cannot publish this app.');
  if (!resource.hasClasses(dataBrowser.classes.view))
    throw new Error('Only an App can use this publication path.');
  if (
    artifact.project !== resource.subject ||
    (await artifactDigest(artifact.files, artifact.assets)) !== artifact.digest
  )
    throw new Error('Release does not match the reviewed app artifact.');
  return uploadStaticRelease(store, resource, artifact);
}

async function uploadStaticRelease(
  store: Store,
  resource: Resource,
  artifact: WebsiteArtifact,
) {
  await uploadWebsiteAssets(store, resource.subject, artifact.assets);

  return hostingRequest<HostingStatus>(
    store,
    resource.subject,
    '/deployments',
    {
      version: 1,
      files: artifact.files,
      assets: Object.fromEntries(
        Object.entries(artifact.assets ?? {}).map(([path, asset]) => [
          path,
          asset.hash,
        ]),
      ),
      metadata: {
        renderer: artifact.renderer,
        project: artifact.project,
        config: artifact.config,
      },
    },
  );
}
export async function readWebsiteRelease(
  store: Store,
  drive: string,
  resource: Resource,
): Promise<WebsiteArtifact | undefined> {
  const status = await hostingRequest<HostingStatus>(store, resource.subject);
  const latest = status.state?.deployments.at(-1);

  if (latest) {
    const pkg = await hostingRequest<WebsitePackage>(
      store,
      resource.subject,
      `/preview/${latest}`,
    );
    if (pkg.metadata)
      return readWebsiteVersion(store, resource.subject, latest);
  }

  const { schema } = await readWebsite(store, drive, resource);
  const subject = resource.get(schema.properties!['website-release']);
  if (typeof subject !== 'string') return undefined;
  const release = await store.getResource(subject);

  return readWebsiteExport(store, drive, release, resource.subject);
}

export async function readWebsiteVersion(
  store: Store,
  project: string,
  deployment: string,
): Promise<WebsiteArtifact> {
  const [pkg, status] = await Promise.all([
    hostingRequest<WebsitePackage>(store, project, `/preview/${deployment}`),
    hostingRequest<HostingStatus>(store, project),
  ]);
  if (
    pkg.metadata?.project !== project ||
    pkg.metadata.renderer !== 'atomic-static-v1'
  )
    throw new Error('This version has no compatible preview metadata.');
  const config = websiteConfigSchema.parse(pkg.metadata.config);
  const assets = Object.fromEntries(
    Object.entries(pkg.assets ?? {}).map(([path, hash]) => [
      path,
      { hash, mimeType: `image/${path.split('.').at(-1)}` },
    ]),
  ) as Record<string, WebsiteAsset>;

  return {
    version: 1,
    renderer: 'atomic-static-v1',
    project,
    config,
    files: pkg.files,
    assets,
    digest: await artifactDigest(pkg.files, assets),
    createdAt: new Date(
      status.state?.versions?.[deployment] ??
        status.state?.history.find(h => h.deployment === deployment)?.at ??
        0,
    ).toISOString(),
  };
}

export async function readWebsiteExport(
  store: Store,
  drive: string,
  release: Resource,
  project = String(release.get(core.properties.parent)),
): Promise<WebsiteArtifact> {
  const schema = await findWebsiteSchema(store, drive);
  if (
    !schema.classes?.['website-export'] ||
    !release.hasClasses(schema.classes['website-export'])
  )
    throw new Error('This resource is not a website export.');
  const artifact = JSON.parse(
    String(release.get(schema.properties!['website-artifact'])),
  ) as WebsiteArtifact;
  if (
    artifact.version !== 1 ||
    artifact.renderer !== 'atomic-static-v1' ||
    artifact.project !== project ||
    !artifact.files ||
    (await artifactDigest(artifact.files, artifact.assets)) !== artifact.digest
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
export async function downloadWebsite(artifact: WebsiteArtifact, store: Store) {
  const { ZipWriter, BlobWriter, TextReader, BlobReader } =
    await import('@zip.js/zip.js');
  const zip = new ZipWriter(new BlobWriter('application/zip'), {
    useWebWorkers: false,
  });
  for (const [path, html] of Object.entries(artifact.files))
    await zip.add(path, new TextReader(html));
  for (const [path, asset] of Object.entries(artifact.assets ?? {}))
    await zip.add(
      path,
      new BlobReader(await readWebsiteAsset(store, artifact.project, asset)),
    );
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
