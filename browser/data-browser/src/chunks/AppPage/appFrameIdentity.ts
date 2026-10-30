// @wc-ignore-file
import { useEffect, useState } from 'react';
import { onRowGrantChange } from './rowGrant';

interface FrameContext {
  app: string;
  drive: string;
  table?: string;
  view?: string;
  resource?: string;
}

/** A guest must reread permissions after an acknowledged grant or revocation. */
export function useAppFrameIdentity(context: FrameContext): string {
  const { app, drive, table, view, resource } = context;
  const [permissionRevision, setPermissionRevision] = useState(0);

  useEffect(() => {
    // Resource pages never borrow a table's grant. Listening only to the
    // acknowledgement avoids remounting an already-granted guest merely
    // because an initial status request finished.
    if (!table || !view || resource) return;

    return onRowGrantChange(target => {
      if (
        target &&
        (target.app !== app || target.drive !== drive || target.table !== table)
      )
        return;
      setPermissionRevision(revision => revision + 1);
    });
  }, [app, drive, table, view, resource]);

  return JSON.stringify([
    app,
    drive,
    table,
    view,
    resource,
    permissionRevision,
  ]);
}
