import { useCallback } from 'react';
import { copyToClipboard } from '../helpers/clipboard.js';
import { useTableEditorContext } from '../TableEditorContext.js';
import { CellIndex, CopyValue } from '../types.js';
import { useGetSelectedCells } from './useGetSelectedCells.js';

export function useCopyCommand<T>(
  columns: T[],
  onCopyCommand?: (cells: CellIndex<T>[]) => Promise<CopyValue[][]>,
) {
  const { selectedRow, selectedColumn } = useTableEditorContext();

  const getSelectedCells = useGetSelectedCells(columns);

  const triggerCopyCommand = useCallback(async () => {
    if (selectedColumn === undefined || selectedRow === undefined) {
      return;
    }

    const cells = getSelectedCells();
    const values = await onCopyCommand?.(cells);

    if (values === undefined) {
      return;
    }

    copyToClipboard(values);
  }, [selectedRow, selectedColumn, onCopyCommand, getSelectedCells]);

  return triggerCopyCommand;
}
