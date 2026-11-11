/** Indexed access and whole-result enumeration are explicit backend capabilities.
 * A bounded ORM window must not be cast to this interface. */
export interface IndexedTableRows extends AsyncIterable<string> {
  readonly totalMembers: number;
  getMemberWithIndex(index: number): Promise<string | undefined>;
  getAllMembers(): Promise<string[]>;
}

/** A native window exposes only the currently retained identities. Its length
 * is not a total count, and it offers no whole-collection enumeration. */
export interface WindowedTableRows {
  readonly subjects: readonly string[];
}

export type TableRowSource = IndexedTableRows | WindowedTableRows;

export function tableRowCount(rows: TableRowSource): number {
  return 'subjects' in rows ? rows.subjects.length : rows.totalMembers;
}

/** Local indices refer to the current indexed result or retained window. */
export async function readTableRow(rows: TableRowSource, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= tableRowCount(rows))
    return undefined;

  return 'subjects' in rows
    ? rows.subjects[index]
    : rows.getMemberWithIndex(index);
}

/** A complete, finite result (e.g. quick-filter matches), not an Atomic Store. */
export function tableRowList(subjects: readonly string[]): IndexedTableRows {
  const snapshot = [...subjects];

  return {
    totalMembers: snapshot.length,
    getMemberWithIndex: async index => snapshot[index],
    getAllMembers: async () => [...snapshot],
    async *[Symbol.asyncIterator]() {
      yield* snapshot;
    },
  };
}
