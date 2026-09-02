import { type JSX } from 'react';
import { ResourceContextMenu } from './index';
import { useResourceContextMenuState } from './ResourceContextMenuContext';

/**
 * Renders the single, app-wide resource context menu at the cursor. MUST be
 * mounted inside every provider the menu's actions depend on — the AI sidebar
 * (`AISidebarContextProvider`), the dialog + dropdown portal providers, and the
 * router — otherwise those actions (Add to chat, Use in code, Delete, navigate)
 * silently no-op. It lives inside `NavWrapper`; the state comes from the
 * higher-mounted `ResourceContextMenuProvider`.
 */
export function ResourceContextMenuHost(): JSX.Element | null {
  const { state } = useResourceContextMenuState();

  if (!state) {
    return null;
  }

  // Keyed by `openId` so each open remounts the menu — the invisible trigger
  // re-fires and re-positions at the new cursor point. Keeping it mounted
  // through the menu's own close (rather than clearing state) is what lets the
  // dialogs its items open — Delete confirmation, "Use in code" — survive; they
  // live inside this component and would otherwise unmount the instant the menu
  // closed.
  return (
    <ResourceContextMenu
      key={state.openId}
      subject={state.subject}
      anchorPoint={state.point}
    />
  );
}
