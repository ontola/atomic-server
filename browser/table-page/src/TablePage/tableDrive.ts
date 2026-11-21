import type { Resource, Store } from '@tomic/react';

const DRIVE_PROP = 'https://atomicdata.dev/properties/drive';

/**
 * The drive that owns a table, so its rows and totals are queried under that
 * drive and not under whichever drive happens to be active (a deep link can
 * open a table from another drive). Undefined when it isn't known yet; callers
 * then fall back to the active drive.
 */
export function getTableDrive(
  store: Pick<Store, 'driveOfSubject'>,
  resource: Pick<Resource, 'get' | 'subject'>,
): string | undefined {
  const stamped = resource.get(DRIVE_PROP);

  if (typeof stamped === 'string' && stamped) return stamped;

  // `driveOfSubject` returns the subject itself when the parent chain isn't
  // loaded, which is not a drive.
  const walked = store.driveOfSubject(resource.subject);

  return walked && walked !== resource.subject ? walked : undefined;
}
