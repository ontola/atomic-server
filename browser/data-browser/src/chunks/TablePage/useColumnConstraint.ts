import { useEffectiveConstraint, type Constraint } from '@tomic/react';
import { useContext } from 'react';
import { TablePageContext } from './tablePageContext';

/**
 * The constraint of a column (property) for the table being shown: its row
 * class's `constraints` map, falling back to the Property's legacy
 * `allowsOnly`, `classtype` and `min`/`max`. Pass `classSubject` where the
 * caller already knows the row class (outside the table page context).
 */
export function useColumnConstraint(
  propertySubject: string | undefined,
  classSubject?: string,
): Constraint {
  const { tableClassSubject } = useContext(TablePageContext);

  return useEffectiveConstraint(
    [classSubject ?? tableClassSubject],
    propertySubject,
  );
}

export { optionSubjects, withConstraint } from '@helpers/withConstraint';
