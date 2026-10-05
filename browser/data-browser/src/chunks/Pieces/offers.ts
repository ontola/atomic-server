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
}

export interface Offer {
  piece: PieceInfo;
  /** Empty for a native match; otherwise the lenses from the table's class. */
  path: LensStep[];
  /** The row classes along the path, starting with the table's own. */
  classes: string[];
}

/**
 * How many lenses an offer may go through. Each hop is a place where meaning
 * can drift (a "status" that is not quite the other side's "status"), and a
 * long chain is hard to explain in a menu. Two lets "template row → shared
 * class → provider shape" work, which is the common case.
 */
export const MAX_LENS_HOPS = 2;

export interface OfferOptions {
  maxHops?: number;
  /**
   * Whether views may be offered through lenses. Off for now: a view reads
   * rows itself, so it would need the host to hand it projected rows and to
   * write its edits back through `put`. Integrations already get that (their
   * frame is told the path). See the PR's open questions.
   */
  viewsFollowLenses?: boolean;
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

export function offersForTable(
  pieces: PieceInfo[],
  lenses: LensInfo[],
  rowClass: string | undefined,
  { maxHops = MAX_LENS_HOPS, viewsFollowLenses = false }: OfferOptions = {},
): Offer[] {
  if (!rowClass) return [];

  const reached = reachableClasses(lenses, rowClass, maxHops);
  const offers: Offer[] = [];

  for (const piece of pieces) {
    const followsLenses = piece.kind === 'integration' || viewsFollowLenses;
    let best: Reached | undefined;

    for (const accepted of piece.renders) {
      const route = reached.get(accepted);
      if (!route || (route.path.length > 0 && !followsLenses)) continue;
      if (!best || route.path.length < best.path.length) best = route;
    }

    if (best) offers.push({ piece, ...best });
  }

  return offers;
}
