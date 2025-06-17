import { core, SearchOpts, useServerSearch } from '@tomic/react';
import { useCallback, useMemo } from 'react';
import { useSettings } from '@helpers/AppSettings';
import { useSelectedIndex } from '@hooks/useSelectedIndex';

export function useResourceSearch(
  searchValue: string,
  classType: string | undefined,
  onResultPick: (result: string) => void,
  valuesWhenEmpty: string[] = [],
) {
  const { drive } = useSettings();

  const searchOpts = useMemo(
    (): SearchOpts => ({
      parents: drive,
      filters: classType ? { [core.properties.isA]: classType } : undefined,
      include: false,
    }),
    [drive, classType],
  );
  const { results } = useServerSearch(searchValue, searchOpts);

  const list =
    !searchValue && valuesWhenEmpty !== undefined ? valuesWhenEmpty : results;
  const { selectedIndex, onKeyDown, onMouseOver, onClick, usingKeyboard } =
    useSelectedIndex(
      list,
      i => {
        if (i === undefined) return;

        onResultPick(list[i]);
      },
      { initialIndex: 0, key: searchValue },
    );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Tab') {
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
      }

      onKeyDown(e);
    },
    [onKeyDown],
  );

  return {
    results: list,
    selectedIndex,
    handleKeyDown,
    onMouseOver,
    onClick,
    usingKeyboard,
  };
}
