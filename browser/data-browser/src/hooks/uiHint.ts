import { useSyncExternalStore } from 'react';

/**
 * One in-memory "look here" mechanism for the whole app: a closable callout
 * on a piece of UI (`<UiHint target>` renders it), and a soft preview ring
 * on the same element. In memory on purpose: a hint belongs to the moment it
 * was asked for, not to the device, and must not return after a reload.
 */
export type UiHintTarget =
  | 'drive-title'
  | 'drive-switcher'
  | 'new-row'
  | 'ai-button'
  | 'share-button'
  | 'save-row';

interface Active {
  target: UiHintTarget;
  text: string;
  scope?: string;
}

interface State {
  active?: Active;
  preview?: UiHintTarget;
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

/** Whether the target is rendered now (and laid out, so a ring can be seen). */
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
 */
export function showUiHint(
  target: UiHintTarget,
  text: string,
  options?: { scope?: string; force?: boolean },
): boolean {
  if (!options?.force && !isUiHintTargetShown(target)) return false;
  set({ active: { target, text, scope: options?.scope } });

  return true;
}

export function dismissUiHint(): void {
  if (!state.active) return;
  set({ ...state, active: undefined });
}

/** The soft ring while hovering the thing that would show the callout. */
export function previewUiHint(target: UiHintTarget | undefined): void {
  if (state.preview === target) return;
  if (target && !isUiHintTargetShown(target)) return;
  set({ ...state, preview: target });
}

export function useUiHint(
  target: UiHintTarget,
  scope?: string,
): { text?: string; preview: boolean } {
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
    preview: s.preview === target && !mine,
  };
}
