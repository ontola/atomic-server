import { createContext, useContext, type MouseEvent } from 'react';

export interface ResourceMenuState {
  subject: string;
  point: { x: number; y: number };
  /** Bumped on every open so the host remounts (and re-opens) the menu even for
   * a repeated right-click on the same spot. */
  openId: number;
}

export interface ResourceContextMenuTriggerValue {
  /**
   * Opens the resource context menu (the same actions as the navbar "More"
   * menu) at the cursor. Wire this to an `onContextMenu` handler on any element
   * that represents a resource. No-op for non-atomic subjects.
   */
  openResourceMenu: (subject: string, event: MouseEvent) => void;
}

export interface ResourceContextMenuStateValue {
  state: ResourceMenuState | undefined;
}

/**
 * Trigger context: exposes `openResourceMenu` with a STABLE value so the many
 * widely-mounted consumers (`AtomicLink`, table cells, kanban cards) don't
 * re-render when a menu opens. Kept separate from the (heavy) menu component so
 * low-level consumers don't pull it — and its `ResourceInline` → `AtomicLink`
 * dependency — into their import cycle.
 */
export const ResourceContextMenuContext =
  createContext<ResourceContextMenuTriggerValue>({
    openResourceMenu: () => undefined,
  });

export function useResourceContextMenu(): ResourceContextMenuTriggerValue {
  return useContext(ResourceContextMenuContext);
}

/**
 * State context: read only by the single {@link ResourceContextMenuHost}, which
 * must be mounted deep enough to be inside every provider the menu's actions
 * need (AI sidebar, dialogs, router). Separate from the trigger context so its
 * per-open changes don't re-render the trigger consumers.
 */
export const ResourceContextMenuStateContext =
  createContext<ResourceContextMenuStateValue>({ state: undefined });

export function useResourceContextMenuState(): ResourceContextMenuStateValue {
  return useContext(ResourceContextMenuStateContext);
}
