import type { DerivedColumnSpec, RowActionSpec } from '@tomic/table';
import { stringToSlug } from '@helpers/stringToSlug';

export type ConfiguredColumnEdit =
  | { kind: 'action'; candidate: RowActionSpec; original?: RowActionSpec }
  | {
      kind: 'computed';
      candidate: DerivedColumnSpec;
      original?: DerivedColumnSpec;
      implicit?: { specs: DerivedColumnSpec[]; signature: string };
    };
export function prepareConfiguredColumn<
  T extends { id: string; label: string },
>(current: readonly T[], candidate: T, original?: T): T {
  if (original) return structuredClone({ ...candidate, id: original.id });
  const base = candidate.id || stringToSlug(candidate.label) || 'column';
  let id = base;
  for (let n = 2; current.some(spec => spec.id === id); n++)
    id = `${base}-${n}`;

  return structuredClone({ ...candidate, id });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );

  return value;
}

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Merge only the captured column; retain unrelated current configuration and
 * recognize our own optimistic patch during a failed-save retry. */
export function mergeConfiguredColumn<T extends { id: string }>(
  current: readonly T[],
  desired: T,
  original?: T,
): T[] {
  const existing = current.find(spec => spec.id === desired.id);
  if (original && !existing)
    throw Error(
      'This configured column was removed. Close the editor and reopen it.',
    );
  if (
    existing &&
    !equal(existing, desired) &&
    (!original || !equal(existing, original))
  )
    throw Error(
      'This configured column changed elsewhere. Close the editor and reopen it.',
    );

  return existing
    ? current.map(spec => (spec.id === desired.id ? desired : spec))
    : [...current, desired];
}

/** An absent computed list inherits timer defaults; an explicit empty list does not. */
export function effectiveConfiguredColumns<T>(
  current: T[],
  isSet: boolean,
  signature: string,
  implicit?: { specs: T[]; signature: string },
): T[] {
  if (isSet || !implicit) return current;
  if (signature !== implicit.signature)
    throw Error(
      'The implicit column settings changed. Close the editor and reopen it.',
    );

  return implicit.specs;
}
