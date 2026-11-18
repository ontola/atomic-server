import React, { createContext, useContext } from 'react';

export type RightPanelId = 'ai' | 'comments' | 'followSession';
/**
 * Manages which panel occupies the right side of the screen. Panels are
 * mutually exclusive: opening one closes the other.
 */
export const RightPanelContext = createContext<{
  activePanel: RightPanelId | null;
  setPanelOpen: (
    panel: RightPanelId,
    action: React.SetStateAction<boolean>,
    /** Only for `comments`: the resource the panel is about. */
    commentSubject?: string,
  ) => void;
  togglePanel: (panel: RightPanelId) => void;
  closePanel: (panel: RightPanelId) => void;
  selectedMeeting: string | undefined;
  openMeetingPanel: (subject: string) => void;
  /** See `PanelState.commentSubject`: the resource the comments panel is
   *  about, or `undefined` when it is about the page itself. */
  commentSubject: string | undefined;
  /** Opens (or, for the thread already shown, closes) the comments panel for a
   *  resource inside the page, such as a table row. */
  toggleCommentsFor: (subject: string) => void;
  /** Aims the comments panel back at the page's own resource. */
  clearCommentTarget: () => void;
}>({
  activePanel: null,
  setPanelOpen: () => {},
  togglePanel: () => {},
  closePanel: () => {},
  selectedMeeting: undefined,
  openMeetingPanel: () => {},
  commentSubject: undefined,
  toggleCommentsFor: () => {},
  clearCommentTarget: () => {},
});

export const useRightPanel = () => useContext(RightPanelContext);
