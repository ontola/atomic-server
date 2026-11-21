import { useSyncExternalStore } from 'react';

/**
 * One in-memory "look here" mechanism for the whole app: a closable callout
 * on a piece of UI (`<UiHint target>` renders it). It is either sticky (until
 * closed) or only shown while hovering what would show it. In memory on purpose: a hint belongs to the moment it
 * was asked for, not to the device, and must not return after a reload.
 */
export type UiHintTarget =
  | 'drive-title'
  | 'drive-switcher'
  | 'new-row'
  | 'ai-button'
  | 'share-button'
  | 'save-row'
  | 'start-here';

interface Active {
  target: UiHintTarget;
  text: string;
  scope?: string;
  /** Stays until closed; a hover one goes when the pointer leaves. */
  sticky: boolean;
  /** Bumped to ask the callout for attention (a small nudge). */
  nudge: number;
}

interface State {
  active?: Active;
}

let state: State = {};
const listeners = new Set<() => void>();
const mounted = new Map<UiHintTarget, Set<HTMLElement>>();

const set = (next: State) => {
  state = next;
  listeners.forEach(l => l());
};

/** Called by `<UiHint>` for as long as its element is on the page. */
export function registerUiHintTarget(
  target: UiHintTarget,
  el: HTMLElement,
): () => void {
  const els = mounted.get(target) ?? new Set();
  els.add(el);
  mounted.set(target, els);

  return () => {
    els.delete(el);
  };
}

/** Whether the target is rendered now (and laid out, so it can be seen). */
export function isUiHintTargetShown(target: UiHintTarget): boolean {
  return [...(mounted.get(target) ?? [])].some(
    el => el.getClientRects().length > 0,
  );
}

/**
 * Show the callout on `target`. Returns false (and shows nothing) when the
 * target is not on screen, so the caller can fall back to the plain action.
 * `force` skips that check, for a target that is about to render (the title
 * of the page just navigated to). `scope` picks one of several instances.
 * `hover` shows it only until `hideHoverUiHint`, and never replaces a
 * sticky one. `nudge` makes it bounce toward its target.
 */
export function showUiHint(
  target: UiHintTarget,
  text: string,
  options?: {
    scope?: string;
    force?: boolean;
    hover?: boolean;
    nudge?: boolean;
  },
): boolean {
  if (!options?.force && !isUiHintTargetShown(target)) return false;
  if (options?.hover && state.active?.sticky) return true;

  const prev = state.active;

  set({
    active: {
      target,
      text,
      scope: options?.scope,
      sticky: !options?.hover,
      nudge: (prev?.nudge ?? 0) + (options?.nudge ? 1 : 0),
    },
  });

  return true;
}

export function dismissUiHint(): void {
  if (!state.active) return;
  set({ active: undefined });
}

/** Takes away a hover callout (not a sticky one). */
export function hideHoverUiHint(): void {
  if (state.active && !state.active.sticky) dismissUiHint();
}

export function useUiHint(
  target: UiHintTarget,
  scope?: string,
): { text?: string; nudge: number } {
  const s = useSyncExternalStore(
    cb => {
      listeners.add(cb);

      return () => listeners.delete(cb);
    },
    () => state,
  );
  const a = s.active;
  const mine =
    a?.target === target && (a.scope === undefined || a.scope === scope);

  return {
    text: mine ? a.text : undefined,
    nudge: mine ? a.nudge : 0,
  };
}
