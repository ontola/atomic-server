import { dataBrowser, useStore, type Store } from '@tomic/react';
import { useEffect, useState } from 'react';
import { appViewOf } from '@chunks/TablePage/tableViewKinds';
import { appRowExtras } from './rowGrant';

/**
 * The row extras (#1849) declared by the apps shown as views of `table`: the
 * properties those apps keep on its rows besides its columns. Read from the
 * table's views, so it needs no grant lookup and no signed-in agent.
 */
export async function tableRowExtras(
  store: Store,
  drive: string,
  table: string,
): Promise<string[]> {
  const views = (await store.getResource(table)).get(
    dataBrowser.properties.tableViews,
  );

  if (!Array.isArray(views)) return [];

  const apps = new Set<string>();

  for (const view of views) {
    if (typeof view !== 'string') continue;

    const kind = (await store.getResource(view)).get(
      dataBrowser.properties.viewKind,
    );
    const app = appViewOf(typeof kind === 'string' ? kind : undefined);

    if (app) apps.add(app);
  }

  const extras = await Promise.all(
    [...apps].map(app => appRowExtras(store, drive, app)),
  );

  return [...new Set(extras.flat())];
}

function useAsync(
  load: (store: Store, drive: string) => Promise<string[]>,
  key: string | undefined,
): string[] {
  const store = useStore();
  const drive = store.getDrive();
  const [found, setFound] = useState<{ key: string; extras: string[] }>();

  useEffect(() => {
    if (!key || !drive) return;

    let cancelled = false;

    load(store, drive)
      .then(extras => {
        if (!cancelled) setFound({ key, extras });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // `load` is recreated per render by its callers; `key` stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, drive, key]);

  return found && found.key === key ? found.extras : [];
}

/** The row extras `app` declares, for the confirmation text. */
export function useAppRowExtras(app: string | undefined): string[] {
  return useAsync((store, drive) => appRowExtras(store, drive, app!), app);
}

/** The row extras of the apps viewing `table`, to keep out of row fields. */
export function useTableRowExtras(table: string | undefined): string[] {
  return useAsync(
    (store, drive) => tableRowExtras(store, drive, table!),
    table,
  );
}
