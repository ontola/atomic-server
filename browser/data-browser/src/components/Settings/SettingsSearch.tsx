import { createContext, useContext } from 'react';

interface SettingsSearchContext {
  query: string;
  /** When true, a parent section already matched — children should show without filtering. */
  parentMatched: boolean;
  /** The `?section=` of the settings page: the section with this id opens and scrolls into view. */
  section?: string;
  /** Nesting level: 0 for a top-level section, which folds; deeper ones are plain subheadings. */
  depth?: number;
  /** The one top-level section that is open, on a page that keeps only one
   *  open at a time. Pages without `setOpenSection` let each section fold freely. */
  openSection?: string;
  setOpenSection?: (key: string | undefined) => void;
}

const settingsSearchContext = createContext<SettingsSearchContext>({
  query: '',
  parentMatched: false,
});

export const SettingsSearchProvider = settingsSearchContext.Provider;

export function useSettingsSearch() {
  return useContext(settingsSearchContext);
}
