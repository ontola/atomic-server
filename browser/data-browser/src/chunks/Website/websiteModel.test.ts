import { describe, expect, it, vi } from 'vitest';
import {
  core,
  server,
  websiteSchema,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  createWebsite,
  migrateWebsiteTerms,
  starterWebsite,
  updateWebsite,
  websiteTermValue,
  websiteTerms,
  readWebsite,
} from './websiteModel';

const DRIVE = 'did:ad:drive';
const ONTOLOGY = 'did:ad:ontology';
const legacy = {
  project: 'did:ad:legacy-project',
  export: 'did:ad:legacy-export',
  design: 'did:ad:legacy-design',
  release: 'did:ad:legacy-release',
  artifact: 'did:ad:legacy-artifact',
};
const byLocalId: Record<string, string> = {
  'schema:class:website-project': legacy.project,
  'schema:class:website-export': legacy.export,
  'schema:property:website-design': legacy.design,
  'schema:property:website-release': legacy.release,
  'schema:property:website-artifact': legacy.artifact,
};

/** A minimal in-memory resource: enough for the term helpers, no Loro. */
function fakeResource(subject: string, props: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(props));
  const resource = {
    subject,
    error: undefined,
    loading: false,
    get: (prop: string) => values.get(prop),
    set: vi.fn(async (prop: string, value: unknown) => {
      values.set(prop, value);
    }),
    remove: vi.fn((prop: string) => {
      values.delete(prop);
    }),
    getClasses: () => (values.get(core.properties.isA) as string[]) ?? [],
    hasClasses: (...c: string[]) =>
      c.every(x =>
        ((values.get(core.properties.isA) as string[]) ?? []).includes(x),
      ),
    save: vi.fn(async () => 'saved'),
    keys: () => [...values.keys()],
    getPropVals: () => Object.fromEntries(values),
  };

  return resource;
}

function fakeStore(extra: Record<string, unknown> = {}) {
  const drive = fakeResource(DRIVE, {
    [server.properties.defaultOntology]: ONTOLOGY,
  });

  return {
    getResource: vi.fn(async (subject: string) =>
      subject === DRIVE ? drive : fakeResource(subject),
    ),
    findByLocalId: vi.fn(async (_drive: string, _parent: string, id: string) =>
      byLocalId[id] ? { subject: byLocalId[id] } : undefined,
    ),
    newResource: vi.fn(
      async (opts: { isA: string[]; propVals: Record<string, unknown> }) =>
        fakeResource('did:ad:new', {
          [core.properties.isA]: opts.isA,
          ...opts.propVals,
        }),
    ),
    ...extra,
  };
}

const as = (r: unknown) => r as Resource;
const asStore = (s: unknown) => s as Store;
const config = starterWebsite('Old site');

function legacySite() {
  return fakeResource('did:ad:site', {
    [core.properties.isA]: [legacy.project],
    [core.properties.name]: 'Old site',
    [legacy.design]: JSON.stringify(config),
    [legacy.release]: 'did:ad:release',
  });
}

describe('websiteTerms', () => {
  it('uses the fixed terms for a resource with the fixed class', async () => {
    const store = fakeStore();
    const site = fakeResource('s', {
      [core.properties.isA]: [websiteSchema.classes.project],
    });
    const terms = await websiteTerms(asStore(store), DRIVE, as(site));

    expect(terms?.source).toBe('fixed');
    expect(terms?.class).toBe(websiteSchema.classes.project);
    expect(terms?.properties).toEqual(websiteSchema.properties);
    // The fixed class needs no drive lookup.
    expect(store.findByLocalId).not.toHaveBeenCalled();
  });

  it('falls back to the drive ontology terms for a legacy resource', async () => {
    const terms = await websiteTerms(
      asStore(fakeStore()),
      DRIVE,
      as(legacySite()),
    );

    expect(terms).toEqual({
      source: 'legacy',
      class: legacy.project,
      properties: {
        design: legacy.design,
        release: legacy.release,
        artifact: legacy.artifact,
      },
    });
  });

  it('keeps projects and exports apart', async () => {
    const store = asStore(fakeStore());
    const exp = fakeResource('e', { [core.properties.isA]: [legacy.export] });

    expect(await websiteTerms(store, DRIVE, as(exp))).toBeUndefined();
    expect((await websiteTerms(store, DRIVE, as(exp), 'export'))?.class).toBe(
      legacy.export,
    );
  });

  it('is undefined for a resource that is neither', async () => {
    const other = fakeResource('o', { [core.properties.isA]: ['did:ad:doc'] });

    expect(
      await websiteTerms(asStore(fakeStore()), DRIVE, as(other)),
    ).toBeUndefined();
  });

  it('is undefined when the drive has no legacy terms at all', async () => {
    const store = fakeStore({ findByLocalId: vi.fn(async () => undefined) });

    expect(
      await websiteTerms(asStore(store), DRIVE, as(legacySite())),
    ).toBeUndefined();
  });

  it('reads a value from the fixed property first, else the legacy one', async () => {
    const site = legacySite();
    const terms = (await websiteTerms(asStore(fakeStore()), DRIVE, as(site)))!;

    expect(websiteTermValue(as(site), terms, 'release')).toBe('did:ad:release');
    site.set(websiteSchema.properties.release, 'did:ad:newer');
    expect(websiteTermValue(as(site), terms, 'release')).toBe('did:ad:newer');
    expect(websiteTermValue(as(site), terms, 'artifact')).toBeUndefined();
  });
});

describe('migrate on write', () => {
  it('leaves only fixed terms on a legacy website that is updated', async () => {
    const store = asStore(fakeStore());
    const site = legacySite();

    await updateWebsite(store, DRIVE, as(site), {
      ...config,
      title: 'Renamed',
    });

    expect(site.save).toHaveBeenCalledTimes(1);
    expect(site.getClasses()).toEqual([websiteSchema.classes.project]);
    expect(
      JSON.parse(String(site.get(websiteSchema.properties.design))).title,
    ).toBe('Renamed');
    expect(site.get(websiteSchema.properties.release)).toBe('did:ad:release');
    expect(site.get(core.properties.name)).toBe('Renamed');
    expect(site.keys().filter(k => k.startsWith('did:ad:legacy'))).toEqual([]);
    expect(site.keys().sort()).toEqual(
      [
        core.properties.isA,
        core.properties.name,
        websiteSchema.properties.design,
        websiteSchema.properties.release,
      ].sort(),
    );
  });

  it('keeps other classes when swapping the class', async () => {
    const site = legacySite();
    site.set(core.properties.isA, [legacy.project, 'did:ad:other']);
    const terms = (await websiteTerms(asStore(fakeStore()), DRIVE, as(site)))!;

    await migrateWebsiteTerms(as(site), terms);

    expect(site.getClasses()).toEqual([
      websiteSchema.classes.project,
      'did:ad:other',
    ]);
  });

  it('migrates a legacy export, artifact included', async () => {
    const exp = fakeResource('e', {
      [core.properties.isA]: [legacy.export],
      [legacy.artifact]: '{"a":1}',
    });
    const terms = (await websiteTerms(
      asStore(fakeStore()),
      DRIVE,
      as(exp),
      'export',
    ))!;

    await migrateWebsiteTerms(as(exp), terms, 'export');

    expect(exp.getClasses()).toEqual([websiteSchema.classes.export]);
    expect(exp.get(websiteSchema.properties.artifact)).toBe('{"a":1}');
    expect(exp.keys().filter(k => k.startsWith('did:ad:legacy'))).toEqual([]);
  });

  it('does nothing to a resource already on the fixed terms', async () => {
    const site = fakeResource('s', {
      [core.properties.isA]: [websiteSchema.classes.project],
      [websiteSchema.properties.design]: JSON.stringify(config),
    });
    const terms = (await websiteTerms(asStore(fakeStore()), DRIVE, as(site)))!;

    await migrateWebsiteTerms(as(site), terms);

    expect(site.set).not.toHaveBeenCalled();
    expect(site.remove).not.toHaveBeenCalled();
  });

  it('never writes when a legacy website is only read', async () => {
    const site = legacySite();
    const { config: read } = await readWebsite(
      asStore(fakeStore()),
      DRIVE,
      as(site),
    );

    expect(read.title).toBe('Old site');
    expect(site.set).not.toHaveBeenCalled();
    expect(site.remove).not.toHaveBeenCalled();
    expect(site.save).not.toHaveBeenCalled();
    expect(site.getClasses()).toEqual([legacy.project]);
  });
});

describe('createWebsite', () => {
  it('creates the fixed class and property without creating a schema', async () => {
    const store = fakeStore();
    const site = await createWebsite(asStore(store), DRIVE, config);

    expect(store.newResource).toHaveBeenCalledTimes(1);
    expect(store.findByLocalId).not.toHaveBeenCalled();
    expect(store.getResource).not.toHaveBeenCalledWith(ONTOLOGY);
    expect(site.getClasses()).toEqual([websiteSchema.classes.project]);
    expect(site.get(websiteSchema.properties.design)).toBe(
      JSON.stringify(config),
    );
    expect(Object.keys(site.getPropVals())).toEqual(
      expect.not.arrayContaining([legacy.design]),
    );
  });
});
