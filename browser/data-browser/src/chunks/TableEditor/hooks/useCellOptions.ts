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

const sameInteractions = (
  a: Set<KeyboardInteraction>,
  b: Set<KeyboardInteraction>,
) => a.size === b.size && [...a].every(interaction => b.has(interaction));

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
      // Keep the *existing* Set when it already says the same thing. Cells
      // build these inline (`new Set([...])`), so publishing one unconditionally
      // hands the context a new reference — and if the cell is ever remounted
      // by its parent, that new reference re-renders the table, which remounts
      // the cell, which publishes again: a loop with no state actually
      // changing. Comparing contents makes a repeat publish a no-op.
      setDisabledKeyboardInteractions(previous =>
        sameInteractions(previous, options.disabledKeyboardInteractions!)
          ? previous
          : options.disabledKeyboardInteractions!,
      );
    }

    return () => {
      setDisabledKeyboardInteractions(previous =>
        previous.size === 0 ? previous : EMPTY_DISABLED_INTERACTIONS,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledSignature, setDisabledKeyboardInteractions]);
}
