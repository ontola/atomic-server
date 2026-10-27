import type { NativeChannel } from '@tomic/lib';

let host: NativeChannel | undefined;

/** The channel to the app the page runs in (not set outside the app). */
export function setActionsHost(channel: NativeChannel | undefined) {
  host = channel;
  clearTimeout(shownTimer);
  shownTimer = undefined;
  lastShown = undefined;
}

/**
 * What the app can show natively instead of the page: the subject of the
 * resource's class (`dataBrowser.classes.chatroom`), which the app matches
 * exactly.
 */
export type NativeKind = string;

/**
 * Asks the app to open `subject` in its own native screen of that kind (the
 * chat of a meeting or chat room). Resolves true when the app did, false when
 * it has no such screen, does not know the call (an older app, the desktop
 * mock) or there is no app: then the page shows the resource itself.
 */
export async function openNative(
  kind: NativeKind,
  subject: string,
  title = '',
): Promise<boolean> {
  if (!host) return false;

  try {
    return (await host.call('openNative', [kind, subject, title])) === true;
  } catch {
    return false;
  }
}

/** How long a page has to stay on a resource before the app hears of it. */
export const SHOWN_DELAY_MS = 800;

let shownTimer: ReturnType<typeof setTimeout> | undefined;
let lastShown: string | undefined;

/**
 * Tells the app the page now shows `subject` (reached by a link, a folder's
 * child, a resource just created), so it lands in the app's Recents. Only a
 * resource the page stays on counts: one passed through within
 * `SHOWN_DELAY_MS` is not reported, and the same one twice in a row only once.
 * An empty subject (a page without a resource) cancels the pending report.
 */
export function reportShown(subject: string | undefined): void {
  clearTimeout(shownTimer);
  shownTimer = undefined;

  if (!host || !subject || subject === lastShown) return;

  const channel = host;

  shownTimer = setTimeout(() => {
    shownTimer = undefined;
    lastShown = subject;
    // Not knowing the call (an older app) is fine: nothing else depends on it.
    channel.call('opened', [subject]).catch(() => undefined);
  }, SHOWN_DELAY_MS);
}

/** The theme choice of the settings page, as the app hears it. */
export type HostThemeChoice = 'auto' | 'dark' | 'light';

/**
 * Tells the app the person chose a theme on the settings page, so the app's
 * own screens (top bar, bottom bar, home, chat) follow and the two halves of
 * the screen never disagree. "auto" hands the choice back to the system. An
 * app that does not know the call keeps its own.
 */
export function reportTheme(choice: HostThemeChoice): void {
  host?.call('theme', [choice]).catch(() => undefined);
}

/** localStorage key of the "Show icons in the sidebar" setting. */
export const SHOW_SIDEBAR_ICONS_KEY = 'showSidebarIcons';

/**
 * Tells the app the person switched "Show icons in the sidebar" on the settings
 * page. The app owns the one value (its Home list obeys it too) and pushes it
 * back in with `atomicEmbed.setSidebarIcons` and `?sidebarIcons=` at load. An
 * app that does not know the call keeps its own.
 */
export function reportSidebarIcons(show: boolean): void {
  host?.call('sidebarIcons', [show]).catch(() => undefined);
}

/**
 * What the page owns of this session's presence entry. The app owns the rest
 * (`resource`, `following`) and merges these into the entry it announces.
 * `null` clears a field.
 */
export interface HostPresenceFields {
  /** The view's own payload: a cursor inside a document, a table cell. */
  data: unknown;
  /** The thread or chat room being typed in. */
  typing: string | null;
  /** The Meeting this session leads, so joiners open its chat. */
  session: string | null;
}

/**
 * Hands the app the presence fields the page owns (`HostPresenceFields`), to
 * announce with its own. An app that does not know the call keeps announcing
 * without them.
 */
export function reportPresence(fields: HostPresenceFields): void {
  host?.call('presence', [fields]).catch(() => undefined);
}

/** Asks the app to follow `agent`: the app navigates, the page only learns it
 *  through `atomicEmbed.setFollow`. */
export function hostFollow(agent: string): void {
  host?.call('follow', [agent]).catch(() => undefined);
}

/** Asks the app to stop following. */
export function hostUnfollow(): void {
  host?.call('unfollow', []).catch(() => undefined);
}

/**
 * Tells the app this device started leading `meeting` (the page wrote the
 * resources). The app keeps the lead, announces it as the presence `session`,
 * posts the "Viewing" trail and pushes it back in with `atomicEmbed.setMeeting`.
 */
export function hostMeetingStarted(meeting: string): void {
  host?.call('meetingStarted', [meeting]).catch(() => undefined);
}

/** Tells the app the meeting this device led has ended. */
export function hostMeetingEnded(meeting: string): void {
  host?.call('meetingEnded', [meeting]).catch(() => undefined);
}

/** Whether the page runs in an app that can answer its calls (not the
 *  desktop mock, not a plain browser). */
export function hasActionsHost(): boolean {
  return !!host;
}

/**
 * Asks the app to start the audio/video call of `meeting`. The web view of
 * this page is replaced when the app navigates (following the leader), so the
 * call lives in a page of its own that the app keeps (`?call=`, see
 * `CallPage.tsx`). Resolves true when the app took the call, false when it
 * cannot (an older app, the desktop mock, no microphone permission yet
 * decided against): the page then hides its call button.
 */
export async function joinCall(meeting: string): Promise<boolean> {
  if (!host) return false;

  try {
    return (await host.call('joinCall', [meeting])) === true;
  } catch {
    return false;
  }
}

/** The call page's Leave button: the app ends the call (and its tile). */
export function leaveCall(): void {
  host?.call('leaveCall', []).catch(() => undefined);
}
