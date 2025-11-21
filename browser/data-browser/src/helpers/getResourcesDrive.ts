import type { Resource, Store } from '@tomic/react';

export async function getResourcesDrive(resource: Resource, store: Store) {
  const ancestry = await store.getResourceAncestry(resource);
  const driveSubject = ancestry.at(-1);

  if (!driveSubject) {
    throw new Error('ResourceWithoutDrive');
  }

  return driveSubject;
}
