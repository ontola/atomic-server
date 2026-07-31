import {
  core,
  dataBrowser,
  useArray,
  useCanWrite,
  useStore,
  useValue,
  type Resource,
} from '@tomic/react';
import { useCallback, useMemo } from 'react';
import {
  parseLayout,
  type BlockKind,
  type BlockPlacement,
} from './dashboardBlocks';

export interface UseDashboardResult {
  /** The blocks this dashboard shows, in order. */
  blocks: string[];
  /** Where each laid-out block sits. Blocks without a placement flow. */
  layout: BlockPlacement[];
  canWrite: boolean;
  /** Creates a block of the given kind, links it, and returns its subject. */
  addBlock: (kind: BlockKind, name: string) => Promise<string | undefined>;
  /** Unlinks a block and destroys it. */
  removeBlock: (subject: string) => Promise<void>;
  /** Moves a block one place earlier or later in the order. */
  moveBlock: (subject: string, direction: -1 | 1) => Promise<void>;
  /** Persists a placement (or clears one by passing undefined). */
  setPlacement: (
    subject: string,
    placement: Omit<BlockPlacement, 'subject'> | undefined,
  ) => Promise<void>;
}

/**
 * A Dashboard's blocks and layout.
 *
 * Every mutation is an ordinary commit on the Dashboard (or the Block), so an
 * assistant writing the same resources and a person clicking a button end up in
 * the same place — which is the whole reason blocks are resources.
 */
export function useDashboard(dashboard: Resource): UseDashboardResult {
  const store = useStore();
  const canWrite = useCanWrite(dashboard);
  const [blocks] = useArray(dashboard, dataBrowser.properties.dashboardBlocks);
  const [storedLayout] = useValue(
    dashboard,
    dataBrowser.properties.dashboardLayout,
  );

  // Serialized dep: parsing hands back a fresh array every render, and this one
  // reaches the rendered grid.
  const layoutKey = JSON.stringify(storedLayout ?? null);
  const layout = useMemo(() => parseLayout(JSON.parse(layoutKey)), [layoutKey]);

  const addBlock = useCallback(
    async (kind: BlockKind, name: string): Promise<string | undefined> => {
      const created = await store.newResource({
        parent: dashboard.subject,
        isA: dataBrowser.classes.block,
        propVals: {
          [core.properties.name]: name,
          [dataBrowser.properties.blockKind]: kind,
        },
      });
      await created.save();
      await dashboard.push(
        dataBrowser.properties.dashboardBlocks,
        [created.subject],
        true,
      );
      await dashboard.save();

      return created.subject;
    },
    [store, dashboard],
  );

  const removeBlock = useCallback(
    async (subject: string): Promise<void> => {
      const next = (blocks as string[]).filter(b => b !== subject);
      await dashboard.set(dataBrowser.properties.dashboardBlocks, next, false);
      // A placement for a block that no longer exists would be dead config that
      // a later reorder writes back forever.
      const remaining = layout.filter(p => p.subject !== subject);
      // Validated, like every other JSON-datatype write here: the property
      // fetch is what records the datatype tag the read path needs.
      await dashboard.set(
        dataBrowser.properties.dashboardLayout,
        remaining as unknown as never,
      );
      await dashboard.save();
      await store.getResourceLoading(subject).destroy();
    },
    [blocks, layout, dashboard, store],
  );

  const moveBlock = useCallback(
    async (subject: string, direction: -1 | 1): Promise<void> => {
      const current = [...(blocks as string[])];
      const from = current.indexOf(subject);
      const to = from + direction;

      if (from === -1 || to < 0 || to >= current.length) {
        return;
      }

      current.splice(to, 0, ...current.splice(from, 1));
      await dashboard.set(
        dataBrowser.properties.dashboardBlocks,
        current,
        false,
      );
      await dashboard.save();
    },
    [blocks, dashboard],
  );

  const setPlacement = useCallback(
    async (
      subject: string,
      placement: Omit<BlockPlacement, 'subject'> | undefined,
    ): Promise<void> => {
      const next = layout.filter(p => p.subject !== subject);

      if (placement) {
        next.push({ subject, ...placement });
      }

      await dashboard.set(
        dataBrowser.properties.dashboardLayout,
        next as unknown as never,
      );
      await dashboard.save();
    },
    [layout, dashboard],
  );

  return {
    blocks: blocks as string[],
    layout,
    canWrite,
    addBlock,
    removeBlock,
    moveBlock,
    setPlacement,
  };
}
