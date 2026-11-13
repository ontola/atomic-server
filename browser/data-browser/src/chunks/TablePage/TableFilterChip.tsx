import { Datatype, Property, isAtomicIdentifier } from '@tomic/react';
import type { TableFilterTarget } from '@tomic/table';
import { Popover } from '@components/Popover';
import { BasicSelect } from '@components/forms/BasicSelect';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { ResourceInline } from '@views/ResourceInline';
import type { ContextType } from 'react';
import { TablePageContext } from './tablePageContext';
import {
  DERIVED_FILTER_OPERATORS,
  derivedFilterUnit,
  operatorLabel,
  operatorLabelForColumn,
  operatorsForDatatype,
  type TableFilter,
} from './tableFiltering';
import type { DerivedColumnSpec } from './derivedColumns';
import { TableFilterValueInput } from './TableFilterValueInput';

/** Atomic metadata/value leaves for the shared bar and chip. */
export function atomicFilterTarget(
  key: string,
  label: string,
  viewKind: ContextType<typeof TablePageContext>['viewKind'],
  column?: Property,
  derived?: DerivedColumnSpec,
): TableFilterTarget {
  const choices = derived
    ? DERIVED_FILTER_OPERATORS
    : column
      ? operatorsForDatatype(column.datatype)
      : [];
  const labelOperator = (operator: TableFilter['operator']) =>
    derived || !column
      ? operatorLabel(operator)
      : operatorLabelForColumn(operator, column.datatype);
  const unit = derived ? derivedFilterUnit(derived) : undefined;

  return {
    key,
    chip: {
      label,
      operatorLabel: labelOperator,
      operators: choices.map(value => ({ value, label: labelOperator(value) })),
      derivedUnit: unit,
      Popover,
      Input: InputStyled,
      Select: BasicSelect,
      Wrapper: InputWrapper,
      messages: {
        remove: 'Remove filter',
        operator: 'Filter operator',
        compare: 'Compare against',
        now: /* @wc-include */ 'now',
        date: /* @wc-include */ 'a date',
        value: 'Filter value',
        unavailable: 'This column is unavailable.',
      },
      renderValueInput: column
        ? state => <TableFilterValueInput property={column} {...state} />
        : undefined,
      renderValueSummary: value =>
        value.startsWith('http') || isAtomicIdentifier(value) ? (
          <ResourceInline subject={value} untabbable />
        ) : (
          <span>{unit?.suffix ? `${value} ${unit.suffix}` : value}</span>
        ),
      hint:
        viewKind === 'calendar' &&
        (column?.datatype === Datatype.DATE ||
          column?.datatype === Datatype.TIMESTAMP)
          ? "This filters on each entry's own date. A repeating entry is matched on its first date, not on the days it repeats on."
          : undefined,
    },
  };
}
