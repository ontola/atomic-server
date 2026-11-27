import { Datatype, type Property } from '@tomic/react';
import type { DerivedColumnSpec } from '../derivedColumns.js';
import type { ViewKind } from '../tableViewKinds.js';

function isInstantProperty(property: Property): boolean {
  return property.datatype === Datatype.TIMESTAMP;
}

/** Resolve the same stored or inferred timestamp pair for display and queries. */
export function resolveTimerProperties(
  columns: Property[],
  startSubject?: string,
  endSubject?: string,
) {
  const timestamps = columns.filter(isInstantProperty);
  const storedStart = timestamps.find(
    column => column.subject === startSubject,
  );
  const storedEnd = timestamps.find(column => column.subject === endSubject);
  const start =
    storedStart ?? timestamps.find(column => /^start/.test(column.shortname));
  const endCandidate =
    storedEnd ??
    timestamps.find(column => /^(end|stop|finish)/.test(column.shortname));
  const end =
    endCandidate?.subject === start?.subject ? undefined : endCandidate;

  return { start, end, storedStart, storedEnd };
}

export function effectiveViewDerivedColumns(
  viewKind: ViewKind,
  stored: DerivedColumnSpec[],
  configured: boolean,
  columns: Property[],
  startSubject?: string,
  endSubject?: string,
): DerivedColumnSpec[] {
  if (viewKind !== 'timer' || configured || stored.length > 0) return stored;

  const { start, end } = resolveTimerProperties(
    columns,
    startSubject,
    endSubject,
  );
  if (!start || !end) return stored;

  return [
    {
      id: 'duration',
      label: 'Duration',
      formula: 'coalesce(end, now()) - start',
      vars: { start: start.subject, end: end.subject },
      valueKind: 'duration',
      width: 130,
    },
  ];
}
