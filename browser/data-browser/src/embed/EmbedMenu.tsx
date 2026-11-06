// @wc-ignore-file
import { useEffect, useRef } from 'react';
import { ResourceContextMenu } from '../components/ResourceContextMenu';
import {
  consumeMenu,
  dialogOpen,
  isMenuItemTarget,
  menuConsumed,
  reportMenuState,
  watchIdle,
} from './menuOverlay';

const ITEM_GRACE_MS = 900;

interface EmbedMenuProps {
  subject: string;
  /** The app's id for this showing of the menu. */
  id: string;
  anchor: { x: number; y: number };
}

/**
 * Nothing but the resource's "more" menu, the same `ResourceContextMenu` as
 * the web navbar's, over the app's native screen: a transparent page. Tells
 * the app when the menu and the dialogs of its actions are gone (`closed`) or
 * an action went to a page (`page`).
 */
export function EmbedMenu({ subject, id, anchor }: EmbedMenuProps) {
  const active = useRef(false);
  const closed = useRef(false);
  const lastTapWasItem = useRef(false);
  const again = menuConsumed(id);

  useEffect(() => {
    if (again) {
      // Back from an action's page: the menu was already used.
      closed.current = true;
      reportMenuState('closed');

      return;
    }

    const style = document.createElement('style');

    style.textContent =
      'html, body, #root { background: transparent !important; }';
    document.head.append(style);

    const onPointer = (e: Event) => {
      lastTapWasItem.current = isMenuItemTarget(e.target);
    };

    document.addEventListener('pointerdown', onPointer, true);

    // Strict mode runs this twice before the menu is really shown; only a
    // menu that stayed mounted counts as used.
    const mark = setTimeout(() => consumeMenu(id), 0);
    const stop = watchIdle({
      busy: () => active.current || dialogOpen(),
      // Dismissed by a tap outside: gone at once. After an item: its dialog
      // may still be on its way.
      grace: () => (lastTapWasItem.current ? ITEM_GRACE_MS : 0),
      onIdle: () => {
        closed.current = true;
        consumeMenu(id);
        reportMenuState('closed');
      },
    });

    return () => {
      clearTimeout(mark);
      stop();
      style.remove();
      document.removeEventListener('pointerdown', onPointer, true);

      // Unmounted for good while still in use: an action navigated away.
      if (menuConsumed(id) && !closed.current) reportMenuState('page');
    };
  }, [id, again]);

  if (again) return null;

  return (
    <ResourceContextMenu
      subject={subject}
      isMainMenu
      anchorPoint={anchor}
      bindActive={isActive => {
        active.current = isActive;
      }}
    />
  );
}
