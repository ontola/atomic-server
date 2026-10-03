import {
  GENESIS,
  Resource,
  core,
  isAtomicIdentifier,
  useStore,
} from '@tomic/react';
import { useSyncExternalStore } from 'react';

const DRIVE = 'https://atomicdata.dev/properties/drive';

/** What `store.newResource` writes into a row before the user types. */
const SEEDED = new Set<string>([
  core.properties.isA,
  core.properties.parent,
  DRIVE,
  GENESIS,
]);

/**
 * A new row whose genesis has not been signed yet. It has its final subject,
 * but it exists only in this tab until it is saved.
 */
export function isUnsavedDraft(resource: Resource): boolean {
  return resource.new && isAtomicIdentifier(resource.subject);
}

/** Whether the row holds anything beyond what creating it wrote. */
export function hasUserContent(resource: Resource): boolean {
  return resource.getEntries().some(([property]) => !SEEDED.has(property));
}

/**
 * {@link isUnsavedDraft}, kept current: `new` is a plain field on the resource,
 * so reading it during render goes stale once the row is saved.
 */
export function useIsUnsavedDraft(resource: Resource): boolean {
  const store = useStore();

  return useSyncExternalStore(
    callback => store.subscribe(resource.subject, callback),
    () => isUnsavedDraft(resource),
  );
}

/** A draft this session created that has since been saved. */
export function isSavedDraft(resource: Resource): boolean {
  return !resource.new && isAtomicIdentifier(resource.subject);
}
