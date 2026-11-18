import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@tomic/react';
import type { DriveApp } from '@chunks/AppPage/useDriveApps';
import { loadPieces } from './loadPieces';
import { offersForTable, type Offer } from './offers';

export interface PieceOffers {
  views: Offer[];
  integrations: Offer[];
  /** Lens subject to its name, to explain an offer that goes through one. */
  lensNames: Map<string, string>;
  /**
   * Reads the pieces and lenses again. The Connect menu calls it as it opens,
   * so a lens approved since the table was opened is picked up without a
   * reload.
   */
  refresh: () => void;
}

const EMPTY: PieceOffers = {
  views: [],
  integrations: [],
  lensNames: new Map(),
  refresh: () => undefined,
};

/**
 * What `rowClass`'s table offers, split into views and integrations. Reloaded
 * whenever the drive's apps change (`useDriveApps` already watches those, and
 * refreshes when the menus open) and on `refresh()`; lenses are read
 * alongside.
 *
 * `enabled` false returns nothing and reads nothing, so tables pay no cost
 * unless the exploration is switched on.
 */
export function usePieceOffers(
  drive: string | undefined,
  apps: DriveApp[],
  rowClass: string | undefined,
  enabled: boolean,
): PieceOffers {
  const store = useStore();
  const [offers, setOffers] = useState<Omit<PieceOffers, 'refresh'>>(EMPTY);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(g => g + 1), []);
  const appsKey = JSON.stringify(apps);

  useEffect(() => {
    if (!enabled || !drive) return;

    let cancelled = false;

    loadPieces(store, drive, JSON.parse(appsKey) as DriveApp[])
      .then(({ pieces, lenses }) => {
        if (cancelled) return;

        const all = offersForTable(pieces, lenses, rowClass);
        setOffers({
          views: all.filter(o => o.piece.kind === 'view'),
          integrations: all.filter(o => o.piece.kind === 'integration'),
          lensNames: new Map(lenses.map(l => [l.subject, l.name])),
        });
      })
      .catch(e => console.warn('Could not load pieces', e));

    return () => {
      cancelled = true;
    };
  }, [store, drive, appsKey, rowClass, enabled, generation]);

  return enabled ? { ...offers, refresh } : EMPTY;
}

/** "via Time entry ↔ Clockify time entry", or undefined for a native match. */
export function offerHelper(
  offer: Offer,
  lensNames: Map<string, string>,
): string | undefined {
  if (offer.path.length === 0) return undefined;

  return `Through ${offer.path
    .map(step => lensNames.get(step.lens) ?? step.lens)
    .join(', then ')}`;
}
