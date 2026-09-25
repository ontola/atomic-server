import { useEffect, useRef, useState } from 'react';

export interface ConfigDraft<T> {
  /** Whether the editor holds changes no save has covered yet. */
  edited: boolean;
  /** The config as last saved, which the route grant's rights follow. */
  savedConfig: T;
  /** Call on every editor change. */
  markEdited: () => void;
  /**
   * Saves `draft` through `write`, which gets the config saved before it.
   * Only a save of the latest draft clears `edited`: an offline save can
   * settle after the next edit, and must not take that edit's Save away.
   */
  commit: (draft: T, write: (previous: T) => Promise<void>) => Promise<void>;
}

/**
 * The Installation page's config draft. The editor writes into the resource
 * as you type, so the saved config is kept apart from it.
 */
export function useConfigDraft<T>(config: T): ConfigDraft<T> {
  const [edited, setEdited] = useState(false);
  const [savedConfig, setSavedConfig] = useState<T>(config);
  // Counts edits, so a save that settles late can tell whether it still
  // covers what the editor holds.
  const edits = useRef(0);

  useEffect(() => {
    if (!edited) setSavedConfig(config);
  }, [config, edited]);

  const markEdited = () => {
    edits.current++;
    setEdited(true);
  };

  const commit = async (draft: T, write: (previous: T) => Promise<void>) => {
    const editsAtSave = edits.current;
    await write(savedConfig);
    setSavedConfig(draft);

    if (edits.current === editsAtSave) setEdited(false);
  };

  return { edited, savedConfig, markEdited, commit };
}
