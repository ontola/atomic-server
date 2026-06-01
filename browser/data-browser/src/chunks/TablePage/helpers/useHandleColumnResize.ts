import { Resource, urls, useValue } from '@tomic/react';
import { useCallback } from 'react';

const valueOpts = {
  commit: true,
  commitDebounce: 1000,
};

/**
 * Reads and writes a Table's column widths. The value is a `tableColumnWidths`
 * JSON property holding a plain `number[]` (pixels, in column order).
 *
 * Storing it as a native array (not a `JSON.stringify`'d string) is what makes
 * it round-trip cleanly: arrays go into Loro as a `LoroList` and materialize
 * straight back to an array, so there's no string that the legacy
 * `[`/`{`-string parser could half-parse into the bracket-less `"300,214"` that
 * used to crash the whole table on the next read. A legacy/corrupted value that
 * isn't an array simply falls back to default widths.
 */
export function useHandleColumnResize(
  table: Resource,
): [number[] | undefined, (sizes: number[]) => void] {
  const [columnWidths, setColumnWidths] = useValue(
    table,
    urls.properties.table.tableColumnWidths,
    valueOpts,
  );

  const handleColumnResize = useCallback(
    (sizes: number[]) => {
      setColumnWidths(sizes);
    },
    [setColumnWidths],
  );

  const widths =
    Array.isArray(columnWidths) && columnWidths.length > 0
      ? (columnWidths as number[])
      : undefined;

  return [widths, handleColumnResize];
}
