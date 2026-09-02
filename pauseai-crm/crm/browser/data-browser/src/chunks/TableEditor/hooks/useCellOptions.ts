import { useEffect } from 'react';
import { useTableEditorContext } from '../TableEditorContext';
import { KeyboardInteraction } from '../helpers/keyboardHandlers';

export interface CellOptions {
  hideActiveIndicator?: boolean;
  disabledKeyboardInteractions?: Set<KeyboardInteraction>;
}

// Stable module-level empty Set used by the effect cleanup. Creating a new
// `new Set()` inside the cleanup would dispatch setState with a fresh ref
// every render and re-trigger the very effect we're cleaning up — an
// infinite render loop under React 19's stricter equality checks. Reusing
// one Set ref makes the dispatch a no-op once the context already holds it.
const EMPTY_DISABLED_INTERACTIONS: Set<KeyboardInteraction> = new Set();

export function useCellOptions(options: CellOptions) {
  const { setIndicatorHidden, setDisabledKeyboardInteractions } =
    useTableEditorContext();

  useEffect(() => {
    if (options.hideActiveIndicator) {
      setIndicatorHidden(true);
    }

    return () => {
      if (options.hideActiveIndicator) {
        setIndicatorHidden(false);
      }
    };
  }, [options.hideActiveIndicator, setIndicatorHidden]);

  // Cells frequently rebuild the Set on every render (`new Set([…])`),
  // which makes a reference-keyed dep flap each render — and the cleanup's
  // setState would in turn re-trigger this effect, looping. Key on a
  // stable signature of the Set's contents so the effect runs only when
  // the disabled-interactions set actually changes.
  const disabledSignature = options.disabledKeyboardInteractions
    ? Array.from(options.disabledKeyboardInteractions).sort().join('|')
    : '';

  useEffect(() => {
    if (options.disabledKeyboardInteractions) {
      setDisabledKeyboardInteractions(options.disabledKeyboardInteractions);
    }

    return () => {
      setDisabledKeyboardInteractions(EMPTY_DISABLED_INTERACTIONS);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledSignature, setDisabledKeyboardInteractions]);
}
