import { createContext, useContext } from 'react';

interface SettingsSearchContext {
  query: string;
  /** When true, a parent section already matched — children should show without filtering. */
  parentMatched: boolean;
  /** The `?section=` of the settings page: the section with this id opens and scrolls into view. */
  section?: string;
}

const settingsSearchContext = createContext<SettingsSearchContext>({
  query: '',
  parentMatched: false,
});

export const SettingsSearchProvider = settingsSearchContext.Provider;

export function useSettingsSearch() {
  return useContext(settingsSearchContext);
}
