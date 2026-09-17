import { useResource, useStore, useValue, type Property } from '@tomic/react';
import { useMemo, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import type { TableColumn } from './useTableColumns';
import {
  ROW_ACTION_GENERATORS,
  applyRowAction,
  isRowActionComplete,
  rowActionKey,
  type RowActionSpec,
} from './rowActions';

/**
 * Turns a View's configured row actions into grid columns, through the same
 * `virtual` seam computed columns use — so the editor stack never learns that
 * action columns exist and every table feature keeps working around them.
 */
export function useRowActions(
  specs: RowActionSpec[],
  /** The row class's properties, for the datatype an action writes. */
  classProperties: Property[],
  /** No buttons at all for a viewer who cannot write: an action that is going to
   *  fail is worse than no action. */
  readOnly: boolean,
): TableColumn[] {
  // Serialized deps: the specs are parsed out of the View's JSON, so their
  // identity churns every render, and a fresh `Cell` component per render would
  // remount every button once a second.
  const specsKey = JSON.stringify(specs);
  const propertyMap = useMemo(
    () => new Map(classProperties.map(p => [p.subject, p])),
    [classProperties],
  );

  return useMemo(() => {
    if (readOnly) {
      return [];
    }

    const parsed = JSON.parse(specsKey) as RowActionSpec[];

    return parsed.map((spec): TableColumn => {
      const property = propertyMap.get(spec.property);

      const Cell = ({ subject }: { subject: string }): JSX.Element | null => (
        <RowActionCell subject={subject} spec={spec} property={property} />
      );

      return {
        key: rowActionKey(spec.id),
        virtual: {
          label: spec.label,
          width: ROW_ACTION_GENERATORS[spec.kind]?.width ?? 90,
          Cell,
        },
        rowAction: spec,
      };
    });
  }, [specsKey, propertyMap, readOnly]);
}

/**
 * One row's button.
 *
 * Pressing it is a single commit, so it is rights-checked, synced, in history and
 * undoable for free. What it has to add is *feedback*: the press must read as
 * having happened while the commit is still in flight, which is why the button
 * goes busy and then briefly confirms — the same problem the timer's start/stop
 * had, solved once here.
 */
function RowActionCell({
  subject,
  spec,
  property,
}: {
  subject: string;
  spec: RowActionSpec;
  property: Property | undefined;
}): JSX.Element | null {
  const store = useStore();
  const row = useResource(subject);
  const [busy, setBusy] = useState(false);
  const [justRan, setJustRan] = useState(false);
  // A subscribing read, NOT `row.get(...)`: the React Compiler memoizes on the
  // resource proxy's identity, which does not change when the resource mutates
  // internally — so a render-time `get` left the button stuck on its first value
  // while the cell beside it showed the new one.
  const [current] = useValue(row, spec.property);

  const active = ROW_ACTION_GENERATORS[spec.kind]?.isActive?.(current) ?? false;

  if (!isRowActionComplete(spec)) {
    return null;
  }

  // The trailing row of the grid is a purely local draft (a `_new:` placeholder)
  // that has never been committed, so there is nothing to patch yet. Checked on
  // the subject rather than on `row.new`: reading a mutable field off the
  // resource proxy during render has the same problem as above.
  if (subject.startsWith('_new:')) {
    return null;
  }

  const run = () => {
    setBusy(true);
    void applyRowAction(row, spec, property)
      .then(() => {
        setJustRan(true);
        window.setTimeout(() => setJustRan(false), 800);
      })
      .catch(error => {
        // Never silent: a press that did nothing has to say so, or the user
        // presses again and cannot tell whether the first one worked.
        store.notifyError(error as Error);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Button
      type='button'
      title={spec.label}
      data-testid={`row-action-${spec.id}`}
      data-active={active}
      aria-pressed={
        ROW_ACTION_GENERATORS[spec.kind].isActive ? active : undefined
      }
      disabled={busy}
      $active={active}
      $confirming={justRan}
      onClick={run}
    >
      {spec.label}
    </Button>
  );
}

const Button = styled.button<{ $active: boolean; $confirming: boolean }>`
  width: 100%;
  border: 1px solid
    ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg2)};
  border-radius: ${p => p.theme.radius};
  background-color: ${p =>
    p.$confirming
      ? p.theme.colors.main
      : p.$active
        ? p.theme.colors.mainSelectedBg
        : p.theme.colors.bg};
  color: ${p =>
    p.$confirming
      ? p.theme.colors.bg
      : p.$active
        ? p.theme.colors.main
        : p.theme.colors.text};
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.15rem 0.3rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* The confirm flash fades out rather than snapping, so a fast double press
   * still reads as two presses. */
  transition:
    background-color 0.15s ease-out,
    color 0.15s ease-out;

  &:hover:not(:disabled) {
    border-color: ${p => p.theme.colors.main};
  }

  &:disabled {
    cursor: progress;
    opacity: 0.6;
  }
`;
