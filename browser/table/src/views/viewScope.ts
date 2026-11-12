export type TableViewSelection =
  | { status: 'loading' | 'implicit' }
  | { status: 'selected' | 'missing'; subject: string };

/** Preserve a legacy default reference even when the saved tab list predates it. */
export function tableViewReferences(
  views: readonly string[],
  defaultView?: string,
): string[] {
  return [
    ...new Set(
      [
        ...(defaultView && !views.includes(defaultView) ? [defaultView] : []),
        ...views,
      ].filter(Boolean),
    ),
  ];
}

/** The host must additionally verify the selected record's backend owner.
 * An explicit override may address an unlisted, owned embedded view. A URL
 * selection never falls back to an unfiltered/default view when it is missing. */
export function selectTableView({
  views,
  defaultView,
  requested,
  override,
  loading = false,
  implicitDefault = false,
}: {
  views: readonly string[];
  defaultView?: string;
  requested?: string;
  override?: string;
  loading?: boolean;
  implicitDefault?: boolean;
}): TableViewSelection {
  if (loading) return { status: 'loading' };
  const references = tableViewReferences(views, defaultView);
  const subject =
    override ||
    requested ||
    (implicitDefault ? undefined : defaultView || references[0]);
  if (!subject) return { status: 'implicit' };

  return override === subject || references.includes(subject)
    ? { status: 'selected', subject }
    : { status: 'missing', subject };
}

export function assertTableViewTarget(
  subject: string,
  references: readonly string[],
) {
  if (!references.includes(subject))
    throw Error('Saved view is not part of this table.');
}

/** Reordering changes positions, never membership or another table's records. */
export function assertTableViewOrder(
  current: readonly string[],
  next: readonly string[],
) {
  const expected = new Set(current);
  if (
    next.length !== expected.size ||
    new Set(next).size !== next.length ||
    next.some(subject => !expected.has(subject))
  )
    throw Error('View order must contain each saved view exactly once.');
}

export function assertTableViewOwner(
  expected: { table: string; graph?: string },
  actual: { table: string; graph?: string },
) {
  if (
    !expected.table ||
    expected.table !== actual.table ||
    expected.graph !== actual.graph
  )
    throw Error('Saved view belongs to another table or graph.');
}
