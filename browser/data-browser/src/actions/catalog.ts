import { appActions } from './appActions';
import { resourceActions } from './resourceActions';
import type { ActionContext, ActionDefinition } from './types';

export interface ShortcutHelpEntry {
  id: string;
  shortcut: string;
  label: string;
}

/** Stub for labels that ignore context (all shortcut-bearing actions do). */
const LABEL_CTX = {} as ActionContext;

function helpLabel(action: ActionDefinition): string {
  try {
    return action.shortcutLabel?.(LABEL_CTX) ?? action.label(LABEL_CTX);
  } catch {
    return action.id;
  }
}

/**
 * Every action that carries a shortcut, app-level first, then resource
 * verbs. The shortcuts overlay and `/app/shortcuts` render this — they
 * must not keep a parallel hand-written list.
 */
export function listShortcutHelp(): ShortcutHelpEntry[] {
  return [...appActions, ...resourceActions]
    .filter((action): action is ActionDefinition & { shortcut: string } =>
      Boolean(action.shortcut),
    )
    .map(action => ({
      id: action.id,
      shortcut: action.shortcut,
      label: helpLabel(action),
    }));
}

export const allActions: ActionDefinition[] = [
  ...appActions,
  ...resourceActions,
];
