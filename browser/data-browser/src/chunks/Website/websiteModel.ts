// @wc-ignore-file
import { z } from 'zod';
import {
  core,
  server,
  websiteSchema,
  type Resource,
  type Store,
} from '@tomic/lib';

const resourceSubject = z.string().min(1).max(2048);
const route = z
  .string()
  .regex(
    /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/,
    'Use / or lowercase paths with a trailing slash, such as /about/.',
  );

export const websiteConfigSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    description: z.string().max(400),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    font: z.enum(['sans', 'serif']),
    // Design only. Content is always resolved from explicitly selected resources.
    css: z
      .string()
      .max(20000)
      .refine(
        value => !/[<\\]|@import|url\s*\(/i.test(value),
        'CSS cannot contain markup, escaped tokens or external resources.',
      ),
    pages: z
      .array(
        z
          .object({
            path: route,
            title: z.string().min(1).max(120),
            documents: z.array(resourceSubject).max(30),
            media: z
              .array(
                z
                  .object({
                    subject: resourceSubject,
                    alt: z.string().max(400),
                    caption: z.string().max(400).optional(),
                  })
                  .strict(),
              )
              .max(30)
              .optional(),
            sections: z
              .array(
                z
                  .object({
                    kind: z.enum(['intro', 'document', 'table', 'gallery']),
                    index: z.number().int().min(0).max(29),
                    span: z.enum(['full', 'half', 'third']),
                    className: z.string().regex(/^[a-zA-Z0-9 _-]{0,120}$/),
                  })
                  .strict(),
              )
              .min(1)
              .max(60)
              .optional(),
            tables: z
              .array(
                z
                  .object({
                    table: resourceSubject,
                    title: z.string().max(120),
                    layout: z.enum(['grid', 'table']),
                    search: z.boolean().optional(),
                    // Explicit rows prevent newly added private records entering a release.
                    rows: z.array(resourceSubject).max(200),
                    columns: z
                      .array(
                        z.object({
                          property: resourceSubject,
                          label: z.string().max(120),
                        }),
                      )
                      .min(1)
                      .max(20),
                  })
                  .strict(),
              )
              .max(10),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.pages.map(p => p.path)).size !== config.pages.length)
      ctx.addIssue({ code: 'custom', message: 'Page paths must be unique.' });

    for (const page of config.pages) {
      const seen = new Set<string>();

      for (const section of page.sections ?? []) {
        const key = `${section.kind}:${section.index}`;
        if (
          seen.has(key) ||
          (section.kind === 'document' &&
            section.index >= page.documents.length) ||
          (section.kind === 'table' && section.index >= page.tables.length) ||
          (section.kind === 'intro' && section.index !== 0) ||
          (section.kind === 'gallery' &&
            (section.index !== 0 || !page.media?.length))
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Sections must reference valid content once per page.',
          });
        seen.add(key);
      }
    }

    if (!config.pages.some(p => p.path === '/'))
      ctx.addIssue({
        code: 'custom',
        message: 'A website needs a home page at /.',
      });
  });
export type WebsiteConfig = z.infer<typeof websiteConfigSchema>;

/**
 * Legacy per-drive website terms, created before `website/v1`: the shortnames
 * of the classes and properties an old drive's own ontology holds. Used only to
 * recognise and migrate old websites; remove with `findLegacyWebsiteTerms` once
 * they are migrated.
 */
const LEGACY_SHORTNAMES = {
  classes: { project: 'website-project', export: 'website-export' },
  properties: {
    design: 'website-design',
    release: 'website-release',
    artifact: 'website-artifact',
  },
} as const;

export type WebsiteTermKey = keyof typeof LEGACY_SHORTNAMES.properties;
export type WebsiteKind = keyof typeof LEGACY_SHORTNAMES.classes;

/** The class and property subjects to use for one website or export resource. */
export interface WebsiteTerms {
  /** `legacy` terms are per-drive and are replaced by `fixed` on the next write. */
  source: 'fixed' | 'legacy';
  class: string;
  properties: Record<WebsiteTermKey, string | undefined>;
}

/**
 * Legacy per-drive website terms, created before website/v1; remove once old
 * websites are migrated. Resolves only this feature's own identities in the
 * drive's ontology, by shortname.
 */
async function findLegacyWebsiteTerms(
  store: Store,
  drive: string,
  kind: WebsiteKind,
): Promise<WebsiteTerms | undefined> {
  const root = await store.getResource(drive);
  const parent = root.get(server.properties.defaultOntology);
  if (typeof parent !== 'string') return undefined;
  const find = async (type: 'class' | 'property', shortname: string) =>
    (await store.findByLocalId(drive, parent, `schema:${type}:${shortname}`))
      ?.subject;
  const classSubject = await find('class', LEGACY_SHORTNAMES.classes[kind]);
  if (!classSubject) return undefined;
  const [design, release, artifact] = await Promise.all(
    (['design', 'release', 'artifact'] as const).map(key =>
      find('property', LEGACY_SHORTNAMES.properties[key]),
    ),
  );

  return {
    source: 'legacy',
    class: classSubject,
    properties: { design, release, artifact },
  };
}

/**
 * The one place that decides which terms a website (or export) resource uses:
 * the fixed `website/v1` ones if it has the fixed class, else the legacy
 * per-drive ones, else `undefined` (not a website). Every reader goes through
 * this.
 */
export async function websiteTerms(
  store: Store,
  drive: string,
  resource: Resource,
  kind: WebsiteKind = 'project',
): Promise<WebsiteTerms | undefined> {
  const fixed = websiteSchema.classes[kind];

  if (resource.hasClasses(fixed)) {
    return {
      source: 'fixed',
      class: fixed,
      properties: websiteSchema.properties,
    };
  }

  const legacy = await findLegacyWebsiteTerms(store, drive, kind);

  return legacy && resource.hasClasses(legacy.class) ? legacy : undefined;
}

/** A term's value, from the fixed property if the resource has it, else the one in `terms`. */
export function websiteTermValue(
  resource: Resource,
  terms: WebsiteTerms,
  key: WebsiteTermKey,
): unknown {
  return (
    resource.get(websiteSchema.properties[key]) ??
    (terms.properties[key] ? resource.get(terms.properties[key]) : undefined)
  );
}

/**
 * Moves a legacy resource onto the fixed terms, in the resource only (the
 * caller saves): swaps the class, copies each value to its fixed property and
 * removes the per-drive keys. Does nothing for a resource already on fixed
 * terms. Call on write, never on read.
 */
export async function migrateWebsiteTerms(
  resource: Resource,
  terms: WebsiteTerms,
  kind: WebsiteKind = 'project',
): Promise<void> {
  if (terms.source === 'fixed') return;

  for (const key of ['design', 'release', 'artifact'] as const) {
    const legacy = terms.properties[key];
    const value = websiteTermValue(resource, terms, key);

    if (value !== undefined)
      await resource.set(websiteSchema.properties[key], value as string);
    if (legacy && legacy !== websiteSchema.properties[key])
      resource.remove(legacy);
  }

  await resource.set(core.properties.isA, [
    websiteSchema.classes[kind],
    ...resource.getClasses().filter(c => c !== terms.class),
  ]);
}

export function starterWebsite(
  title = 'My website',
  document?: string,
): WebsiteConfig {
  return {
    version: 1,
    title,
    description: 'Made with Atomic',
    language: 'en',
    accent: '#315c49',
    background: '#f5f3eb',
    font: 'serif',
    css: '',
    pages: [
      {
        path: '/',
        title: 'Home',
        documents: document ? [document] : [],
        tables: [],
      },
    ],
  };
}
export async function createWebsite(
  store: Store,
  drive: string,
  config: WebsiteConfig,
) {
  const parsed = websiteConfigSchema.parse(config);
  await assertPrivateWebsiteParent(store, drive);
  const resource = await store.newResource({
    parent: drive,
    isA: [websiteSchema.classes.project],
    propVals: {
      [core.properties.name]: parsed.title,
      [websiteSchema.properties.design]: JSON.stringify(parsed),
    },
  });
  await saveWebsiteResource(resource);

  return resource;
}
export async function readWebsite(
  store: Store,
  drive: string,
  resource: Resource,
) {
  const terms = await websiteTerms(store, drive, resource);
  if (!terms) throw new Error('This resource is not a website.');
  const property = websiteSchema.properties.design;
  const design = websiteTermValue(resource, terms, 'design');
  if (design === undefined) throw new Error('Website schema is missing.');
  const config = websiteConfigSchema.parse(JSON.parse(String(design)));

  return { config, terms, property };
}
export async function updateWebsite(
  store: Store,
  drive: string,
  resource: Resource,
  config: WebsiteConfig,
) {
  const parsed = websiteConfigSchema.parse(config);
  await assertPrivateWebsiteParent(store, resource.subject);
  const { terms, property } = await readWebsite(store, drive, resource);
  // A write is the moment an old website moves to the fixed terms.
  await migrateWebsiteTerms(resource, terms);
  await resource.set(property, JSON.stringify(parsed));
  await resource.set(core.properties.name, parsed.title);
  await saveWebsiteResource(resource);
}

/** Confidential authoring cannot inherit public rights from a parent. */
export async function assertPrivateWebsiteParent(
  store: Store,
  subject: string,
) {
  const visited = new Set<string>();
  let next: string | undefined = subject;

  while (next) {
    if (visited.has(next) || visited.size >= 32)
      throw new Error('Cannot establish private website ancestry.');
    visited.add(next);
    const resource: Resource = await store.getResource(next);
    if (resource.error || resource.loading)
      throw new Error('Cannot verify website permissions yet.');

    for (const property of [core.properties.read, core.properties.write]) {
      const rights = resource.get(property);
      if (
        Array.isArray(rights) &&
        rights.includes('https://atomicdata.dev/agents/publicAgent')
      )
        throw new Error(
          'Create the website in a private drive. Public parents cannot protect drafts.',
        );
    }

    const parent: unknown = resource.get(core.properties.parent);
    next = typeof parent === 'string' ? parent : undefined;
  }
}

/** Local/outbox writes are not confirmation that a release is durable. */
export async function saveWebsiteResource(resource: Resource) {
  const result = await resource.save();
  if (result === 'offline')
    throw new Error(
      `Changes remain pending locally for ${resource.subject}. Reconnect and save this resource before creating another release.`,
    );
}
