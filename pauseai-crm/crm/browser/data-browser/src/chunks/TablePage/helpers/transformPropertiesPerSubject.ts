import { Collection } from '@tomic/react';
import { CellIndex } from '@chunks/TableEditor';

/** Groups cell payloads (a Property, a TableColumn, …) by their row's subject. */
export const transformToPropertiesPerSubject = async <T>(
  cells: CellIndex<T>[],
  collection: Collection,
): Promise<Record<string, T[]>> => {
  const result: Record<string, T[]> = {};

  for (const [rowIndex, payload] of cells) {
    const subject = await collection.getMemberWithIndex(rowIndex);

    if (!subject) {
      continue;
    }

    result[subject] = [...(result[subject] ?? []), payload];
  }

  return result;
};
