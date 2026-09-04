import type { ActionContext, ActionDefinition } from './types';

/** ⌘K shows at most this many actions, and never interleaves them with hits. */
export const PALETTE_ACTION_CAP = 3;

/** Shorter queries match too much of an open noun search; require a prefix. */
export const PALETTE_MIN_QUERY_LENGTH = 2;

export interface ActionMatch {
  action: ActionDefinition;
  /** Lower is a tighter match (exact beat prefix; shorter remainder wins). */
  score: number;
}

function words(text: string): string[] {
  return text.split(/[\s/&]+/).filter(Boolean);
}

function prefixScore(candidate: string, query: string): number | undefined {
  if (!candidate.startsWith(query)) {
    return undefined;
  }

  // Exact vocabulary hit first, then how much of the word is still unmatched.
  return candidate === query ? 0 : candidate.length - query.length + 1;
}

function bestScore(
  action: ActionDefinition,
  query: string,
  ctx: ActionContext,
): number | undefined {
  let label = '';

  try {
    label = action.label(ctx).toLowerCase();
  } catch {
    // A label that can't resolve (missing resource) still matches on id/keywords.
  }

  const haystacks = [
    action.id.toLowerCase(),
    label,
    ...words(label),
    ...(action.keywords ?? []).map(keyword => keyword.toLowerCase()),
  ];

  let best: number | undefined;

  for (const haystack of haystacks) {
    const score = prefixScore(haystack, query);

    if (score === undefined) {
      continue;
    }

    if (best === undefined || score < best) {
      best = score;
    }
  }

  return best;
}

/**
 * Actions shown in the ⌘K palette for `query`.
 *
 * Placement policy (planning/actions.md): a closed verb set next to an open
 * noun search, never ranked together. A hit is a *prefix* of the action id or
 * a keyword — not a substring of the human label, which would fire on ordinary
 * resource queries ("edit" inside "Editable title"). Capped, and hidden when
 * the action is unavailable.
 */
export function matchActionsForPalette(
  query: string,
  actions: ActionDefinition[],
  ctx: ActionContext,
  cap = PALETTE_ACTION_CAP,
): ActionDefinition[] {
  const needle = query.trim().toLowerCase();

  if (needle.length < PALETTE_MIN_QUERY_LENGTH) {
    return [];
  }

  const matches: ActionMatch[] = [];

  for (const action of actions) {
    try {
      if (!(action.available?.(ctx) ?? true)) {
        continue;
      }

      if (action.disabled?.(ctx)) {
        continue;
      }
    } catch {
      // Incomplete context (tests, or a resource still loading) — skip.
      continue;
    }

    const score = bestScore(action, needle, ctx);

    if (score === undefined) {
      continue;
    }

    matches.push({ action, score });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }

    return a.action.id.localeCompare(b.action.id);
  });

  return matches.slice(0, cap).map(match => match.action);
}
