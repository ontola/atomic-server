import { useState } from 'react';
import { loopingIndex } from '../helpers/loopingIndex';
import { useOnValueChange } from '@helpers/useOnValueChange';

interface UseSelectedIndexOptions {
  initialIndex?: number;
  /** A key to identify if the list changed, usually this would be the search query. */
  key?: string;
}

/**
 * Building blocks for building a combobox or dropdown menu.
 * Handles things like keyboard navigation, mouse over, click and keyboard/mouse takeover.
 * Make sure to apply all listeners returned by this hook to the relevant elements.
 */
export function useSelectedIndex<T, K>(
  list: T[],
  onSelect: (index: number | undefined) => void,
  { initialIndex, key }: UseSelectedIndexOptions = {},
): {
  selectedIndex: number | undefined;
  onKeyDown: (e: React.KeyboardEvent<K>) => void;
  onMouseOver: (index: number) => void;
  onClick: (index: number) => void;
  resetIndex: () => void;
  usingKeyboard: boolean;
} {
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
    initialIndex,
  );
  const [usingKeyboard, setUsingKeyboard] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent<K>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => {
        if (prev === undefined) return 0;

        return loopingIndex(prev + 1, list.length);
      });
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => {
        if (prev === undefined) return list.length - 1;

        return loopingIndex(prev - 1, list.length);
      });
    }

    if (e.key === 'Enter') {
      onSelect(selectedIndex);
    }

    setUsingKeyboard(true);
  };

  const onMouseOver = (index: number) => {
    setSelectedIndex(index);

    setUsingKeyboard(false);
  };

  const onClick = (index: number) => {
    onSelect(index);
  };

  const resetIndex = () => {
    setSelectedIndex(initialIndex);
  };

  useOnValueChange(() => {
    setSelectedIndex(initialIndex);
  }, [key]);

  return {
    selectedIndex,
    onKeyDown,
    onMouseOver,
    onClick,
    resetIndex,
    usingKeyboard,
  };
}
