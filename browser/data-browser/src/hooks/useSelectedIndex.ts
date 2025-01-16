import { useEffect, useState } from 'react';
import { loopingIndex } from '../helpers/loopingIndex';

export function useSelectedIndex<T, K>(
  list: T[],
  onSelect: (index: number | undefined) => void,
): {
  selectedIndex: number | undefined;
  onKeyDown: (e: React.KeyboardEvent<K>) => void;
  onMouseOver: (index: number) => void;
  onClick: (index: number) => void;
  resetIndex: () => void;
  usingKeyboard: boolean;
} {
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(0);
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
    setSelectedIndex(undefined);
  };

  useEffect(() => {
    setSelectedIndex(undefined);
  }, [list]);

  return {
    selectedIndex,
    onKeyDown,
    onMouseOver,
    onClick,
    resetIndex,
    usingKeyboard,
  };
}
