export type RightPanelId = 'ai' | 'comments' | 'followSession';
export type PanelState = {
  scope: string;
  activePanel: RightPanelId | null;
  selectedMeeting?: string;
  /**
   * Which resource the comments panel is about. `undefined` means "the page's
   * own resource" — what the NavBar button opens. It is set when a thread is
   * opened for something *inside* the page, like a table row, which has its own
   * subject but is never the page's current subject.
   */
  commentSubject?: string;
};
export const emptyPanelState = (scope: string): PanelState => ({
  scope,
  activePanel: null,
});

export function updatePanelState(
  previous: PanelState,
  scope: string,
  panel: RightPanelId,
  action: boolean | ((open: boolean) => boolean),
  /** Only meaningful for `comments`: see {@link PanelState.commentSubject}. */
  commentSubject?: string,
): PanelState {
  // Ignore callbacks from a meeting/account operation started in an old scope.
  if (previous.scope !== scope) return previous;
  const current = previous;
  // Pointing the comments panel at a *different* resource is an open, not a
  // toggle: clicking row 3's bubble while row 1's thread is up should switch
  // threads, and the NavBar button should come back to the page's own thread
  // rather than closing a row's.
  const isOpen =
    current.activePanel === panel &&
    (panel !== 'comments' || current.commentSubject === commentSubject);
  const open = typeof action === 'function' ? action(isOpen) : action;
  const activePanel = open ? panel : isOpen ? null : current.activePanel;

  return {
    scope,
    activePanel,
    selectedMeeting:
      activePanel === 'followSession' ? current.selectedMeeting : undefined,
    // `open` is false here only when the request was a no-op for an already
    // open comments panel aimed elsewhere — that panel keeps its own target.
    commentSubject:
      activePanel !== 'comments'
        ? undefined
        : open
          ? commentSubject
          : current.commentSubject,
  };
}

/**
 * Closes `panel` whatever it is aimed at. Toggling through
 * {@link updatePanelState} cannot express this: a close request carries no
 * target, so it would read as "close the page's thread" and leave a row's
 * thread open. Used when the panel's target is gone (deleted, or navigated
 * away from) and when the user dismisses the drawer itself.
 */
export function closePanelState(
  previous: PanelState,
  scope: string,
  panel: RightPanelId,
): PanelState {
  if (previous.scope !== scope || previous.activePanel !== panel) {
    return previous;
  }

  return emptyPanelState(scope);
}
