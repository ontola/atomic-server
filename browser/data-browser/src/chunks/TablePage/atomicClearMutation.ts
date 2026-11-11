import { core, commits, type Resource, type Store } from '@tomic/react';
import type { TableMutationBackend } from '@tomic/table';
import {
  createValueChangedHistoryItem,
  type HistoryItemBatch,
} from './helpers/useTableHistory';

const SCOPE_FIELDS = new Set([
  core.properties.parent,
  core.properties.isA,
  'https://atomicdata.dev/properties/drive',
]);

/** Atomic bulk-clear policy: Resource.save keeps its persisted/offline/no-op
 * policy. Read-back uses Atomic's live cache, not an independent durability proof. */
export function atomicClearMutationBackend(
  store: Store,
  tableClass: Resource,
  history: HistoryItemBatch,
): TableMutationBackend<Resource> {
  return {
    get schema() {
      const revision = tableClass.get(commits.properties.lastCommit);

      return {
        revision: typeof revision === 'string' ? revision : undefined,
        columns: [
          ...new Set([
            ...tableClass.getSubjects(core.properties.requires),
            ...tableClass.getSubjects(core.properties.recommends),
          ]),
        ].map(id => ({ id, writable: !SCOPE_FIELDS.has(id) })),
      };
    },
    read: async target => {
      const resource = await store.getResource(target.subject);

      return {
        target: {
          subject: resource.subject,
          scope: {
            collection: String(resource.get(core.properties.parent) ?? ''),
            rowClass: resource.hasClasses(target.scope.rowClass)
              ? target.scope.rowClass
              : '',
          },
        },
        values: Object.fromEntries(resource.getEntries()),
        handle: resource,
      };
    },
    write: async (current, command, changes) => {
      if (command.kind !== 'update')
        throw Error('This adapter only clears cell values');

      for (const [property, value] of Object.entries(changes)) {
        history.push(createValueChangedHistoryItem(current.handle, property));
        // Preserve Atomic's existing bulk-clear validation/save policy.
        await current.handle.set(
          property,
          value as Parameters<Resource['set']>[1],
          false,
        );
      }

      await current.handle.save();
    },
    // Clears yield undefined or a flat localized-text map. Compare that map
    // without depending on its serialization/key order.
    equals: (left, right) => {
      if (Object.is(left, right)) return true;
      if (
        !left ||
        !right ||
        typeof left !== 'object' ||
        typeof right !== 'object' ||
        Array.isArray(left) ||
        Array.isArray(right)
      )
        return false;
      const a = left as Record<string, unknown>,
        b = right as Record<string, unknown>;

      return (
        Object.keys(a).length === Object.keys(b).length &&
        Object.keys(a).every(
          key => Object.hasOwn(b, key) && Object.is(a[key], b[key]),
        )
      );
    },
  };
}
