// @wc-ignore-file
import type { LensDirection, LensStep } from './lens';

/**
 * What a table offers to install, and why.
 *
 * Pure, so the rule can be read and tested without a store. It generalises
 * `appsForClass` (chunks/AppPage/useDriveApps.ts): with no lenses and only
 * views, the answer is exactly that function's.
 */

export type PieceKind = 'view' | 'integration';

export interface PieceInfo {
  subject: string;
  name: string;
  kind: PieceKind;
  /** The row classes the piece accepts natively (the App's `renders`). */
  renders: string[];
}

export interface LensInfo {
  subject: string;
  name: string;
  source: string;
  target: string;
  /**
   * Whether offers may go through this lens. Lenses from the shared catalog
   * (next to the ontology) are trusted; a drive-local lens is trusted once
   * someone has approved it (Q-089). An unreviewed lens never makes an
   * integration appear: it only shows as "waiting for review".
   */
  trusted: boolean;
}

export interface Offer {
  piece: PieceInfo;
  /** Empty for a native match; otherwise the lenses from the table's class. */
  path: LensStep[];
  /** The row classes along the path, starting with the table's own. */
  classes: string[];
  /**
   * Unreviewed lenses on the path. Non-empty means the offer cannot be taken
   * yet: it is shown disabled, naming the lenses that need review.
   */
  pendingReview: string[];
}

/**
 * How many lenses an offer may go through (Q-091). Each hop is a place where
 * meaning can drift, and a long chain is hard to explain in a menu. Two lets
 * "template row → shared class → provider shape" work, the common case.
 * Lenses are two-way only, so every hop can be walked in both directions.
 */
export const MAX_LENS_HOPS = 2;

export interface OfferOptions {
  maxHops?: number;
}

interface Reached {
  path: LensStep[];
  classes: string[];
}

/**
 * Every class reachable from `rowClass` through at most `maxHops` lenses,
 * each with its shortest path. Lenses are two-way (every converter in
 * `lens.ts` is invertible), so an edge is walked in both directions.
 * Breadth-first, and ties go to the lens listed first, so the answer is
 * deterministic.
 */
export function reachableClasses(
  lenses: LensInfo[],
  rowClass: string,
  maxHops = MAX_LENS_HOPS,
): Map<string, Reached> {
  const reached = new Map<string, Reached>([
    [rowClass, { path: [], classes: [rowClass] }],
  ]);
  let frontier = [rowClass];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];

    for (const from of frontier) {
      const here = reached.get(from)!;

      for (const lens of lenses) {
        const edges: [string, LensDirection][] = [];
        if (lens.source === from) edges.push([lens.target, 'forward']);
        if (lens.target === from) edges.push([lens.source, 'backward']);

        for (const [to, direction] of edges) {
          if (reached.has(to)) continue;

          reached.set(to, {
            path: [...here.path, { lens: lens.subject, direction }],
            classes: [...here.classes, to],
          });
          next.push(to);
        }
      }
    }

    frontier = next;
  }

  return reached;
}

function shortest(
  reached: Map<string, Reached>,
  piece: PieceInfo,
): Reached | undefined {
  let best: Reached | undefined;

  for (const accepted of piece.renders) {
    const route = reached.get(accepted);
    // Views stay exact-match (Q-087): a view reads rows itself, so a lens
    // would need the host to translate its reads and its edits.
    if (!route || (route.path.length > 0 && piece.kind === 'view')) continue;
    if (!best || route.path.length < best.path.length) best = route;
  }

  return best;
}

/**
 * Every piece this table offers. Views match the row class exactly;
 * integrations also match through up to `maxHops` trusted lenses. An
 * integration reachable only through an unreviewed lens is returned with
 * `pendingReview` set, so the UI can say what is holding it back.
 */
export function offersForTable(
  pieces: PieceInfo[],
  lenses: LensInfo[],
  rowClass: string | undefined,
  { maxHops = MAX_LENS_HOPS }: OfferOptions = {},
): Offer[] {
  if (!rowClass) return [];

  const trusted = reachableClasses(
    lenses.filter(l => l.trusted),
    rowClass,
    maxHops,
  );
  const any = reachableClasses(lenses, rowClass, maxHops);
  const untrusted = new Set(lenses.filter(l => !l.trusted).map(l => l.subject));
  const offers: Offer[] = [];

  for (const piece of pieces) {
    const usable = shortest(trusted, piece);

    if (usable) {
      offers.push({ piece, ...usable, pendingReview: [] });
      continue;
    }

    const blocked = shortest(any, piece);

    if (blocked) {
      offers.push({
        piece,
        ...blocked,
        pendingReview: blocked.path
          .map(step => step.lens)
          .filter(lens => untrusted.has(lens)),
      });
    }
  }

  return offers;
}
