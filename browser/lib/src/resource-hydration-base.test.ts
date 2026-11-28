import { describe, expect, it, vi } from 'vitest';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { commits } from './ontologies/commits.js';
import { Resource } from './resource.js';
import type { Store } from './store.js';

const SUBJECT = 'https://example.com/drive/ontology';
const PARENT = 'https://example.com/drive';
const TERM = 'atomic:prop:new-property';

/** JSON-AD can carry a parent that the server's older Loro snapshot lacks. */
function hydrateOntology(withSnapshot: boolean) {
  const server = new LoroLoader.Loro.LoroDoc();
  const properties = server.getMap('properties');
  properties.set(core.properties.isA, [core.classes.ontology]);
  properties.set(core.properties.name, 'Drive ontology');
  server.commit();

  const markDirty = vi.fn();
  const resource = new Resource(SUBJECT);
  resource.setStore({
    canCommit: true,
    resources: new Map(),
    getServerUrl: () => 'https://example.com',
    outbox: { hasPending: () => false, markDirty },
    isOwnedSubject: () => true,
    isLocalOnlySubject: () => false,
    notifyResourceUpdated: vi.fn(),
  } as unknown as Store);
  resource.applyHydratedValues([
    [core.properties.isA, [core.classes.ontology]],
    [core.properties.name, 'Drive ontology'],
    [core.properties.parent, PARENT],
  ]);

  if (withSnapshot) {
    resource.applyHydratedValues([
      [commits.properties.loroUpdate, server.export({ mode: 'snapshot' })],
    ]);
  }

  resource.loading = false;

  return { resource, server, markDirty };
}

describe('a first edit after server hydration', () => {
  it.each([true, false])(
    'exports the base needed by a schema-list append (snapshot: %s)',
    withSnapshot => {
      const { resource, server, markDirty } = hydrateOntology(withSnapshot);
      resource.getLoroDoc();
      expect(resource.get(core.properties.parent)).toBe(PARENT);
      expect(markDirty).not.toHaveBeenCalled();
      expect(resource.hasUnsavedChanges()).toBe(false);

      // ensureSchema appends its freshly created terms to this same list.
      // Hydration produced local ops, but they have never reached the server.
      resource.pushListItem(core.properties.properties, TERM);
      const exported = resource.exportLoroDeltaForDrain(false)!;
      expect(exported).toBeDefined();
      const imported = server.import(exported.bytes);

      expect(imported.pending).toBeNull();
      expect(server.getMap('properties').toJSON()).toMatchObject({
        [core.properties.parent]: PARENT,
        [core.properties.properties]: [TERM],
      });

      // Once accepted, subsequent edits can use an incremental cursor again.
      resource.markLoroSavedAt(exported.versionAfterExport);
      resource.pushListItem(core.properties.properties, 'atomic:prop:second');
      const next = resource.exportLoroDeltaForDrain(false)!;
      expect(server.import(next.bytes).pending).toBeNull();
      expect(server.getMap('properties').toJSON()).toMatchObject({
        [core.properties.properties]: [TERM, 'atomic:prop:second'],
      });
    },
  );
});
