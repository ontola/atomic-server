// @wc-ignore-file
/**
 * The app's native screens (a chat room, the AI chat) have no page of their
 * own, but their "more" menu is the web app's: the app shows this page over
 * the screen with nothing on it but `ResourceContextMenu` (and the dialogs its
 * actions open), via `atomicEmbed.showMenu`. These helpers tell the app when
 * that is over.
 */
import { flutterChannel } from './flutterHost';

/** What the app hears (`{method: 'menuState', state}`):
 * - `closed`: the menu and every dialog it opened are gone; close the overlay.
 * - `page`: an action navigated to a page of its own (history, share, a
 *   resource): the overlay is that page now, not a transparent menu. */
export type MenuState = 'closed' | 'page';

export function reportMenuState(state: MenuState): void {
  flutterChannel()?.postMessage(JSON.stringify({ method: 'menuState', state }));
}

/** Menus already shown, by the app's id for them: going back to one (from an
 * action's page) must not open it again. */
const consumed = new Set<string>();

export function menuConsumed(id: string): boolean {
  return consumed.has(id);
}

export function consumeMenu(id: string): void {
  consumed.add(id);
}

/** Dialogs the menu's actions open are native `<dialog>`s. */
export function dialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/** A tap on an item of the menu (not outside it). */
export function isMenuItemTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role=menuitem]') !== null
  );
}

/**
 * Calls `onIdle` once `busy()` has been true and then stayed false for
 * `grace()` ms. The grace covers an action that closes the menu and opens its
 * dialog a moment later (a dialog's code loads lazily). Returns the stop.
 */
export function watchIdle(options: {
  busy: () => boolean;
  grace: () => number;
  onIdle: () => void;
  pollMs?: number;
}): () => void {
  let seenBusy = false;
  let idleSince: number | undefined;

  const timer = setInterval(() => {
    if (options.busy()) {
      seenBusy = true;
      idleSince = undefined;

      return;
    }

    if (!seenBusy) return;

    idleSince ??= Date.now();

    if (Date.now() - idleSince >= options.grace()) {
      clearInterval(timer);
      options.onIdle();
    }
  }, options.pollMs ?? 50);

  return () => clearInterval(timer);
}
