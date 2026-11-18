import {
  Datatype,
  Property,
  core,
  isAtomicIdentifier,
  unknownSubject,
  useResource,
  useString,
} from '@tomic/react';
import { type JSX, useContext } from 'react';
import { TableFilterChip as SharedFilterChip } from '@tomic/table';
import { Popover } from '@components/Popover';
import { BasicSelect } from '@components/forms/BasicSelect';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { ResourceInline } from '@views/ResourceInline';
import { columnLabel } from './helpers/columnLabel';
import { TablePageContext } from './tablePageContext';
import {
  DERIVED_FILTER_OPERATORS,
  derivedFilterUnit,
  filterKey,
  operatorLabel,
  operatorLabelForColumn,
  operatorsForDatatype,
  type TableFilter,
} from './tableFiltering';
import type { DerivedColumnSpec } from './derivedColumns';
import { TableFilterValueInput } from './TableFilterValueInput';

interface TableFilterChipProps {
  filter: TableFilter;
  column?: Property;
  derived?: DerivedColumnSpec;
}

export function TableFilterChip({
  filter,
  column,
  derived,
}: TableFilterChipProps): JSX.Element {
  const { setFilterValue, setFilterOperator, removeFilter, viewKind } =
    useContext(TablePageContext);
  const propResource = useResource(column?.subject ?? unknownSubject);
  const [name] = useString(propResource, core.properties.name);
  const key = filterKey(filter);
  const label = derived
    ? derived.label
    : column
      ? columnLabel(name, column.shortname)
      : 'Unavailable column';
  const choices = derived
    ? DERIVED_FILTER_OPERATORS
    : column
      ? operatorsForDatatype(column.datatype)
      : [];
  const labelOperator = (operator: typeof filter.operator) =>
    derived || !column
      ? operatorLabel(operator)
      : operatorLabelForColumn(operator, column.datatype);
  const unit = derived ? derivedFilterUnit(derived) : undefined;

  return (
    <SharedFilterChip
      filter={filter}
      label={label}
      operatorLabel={labelOperator(filter.operator)}
      operators={choices.map(value => ({ value, label: labelOperator(value) }))}
      onValueChange={value => setFilterValue(key, value)}
      onOperatorChange={operator => setFilterOperator(key, operator)}
      onRemove={() => removeFilter(key)}
      unavailable={!column && !derived}
      derivedUnit={unit}
      Popover={Popover}
      Input={InputStyled}
      Select={BasicSelect}
      Wrapper={InputWrapper}
      messages={{
        remove: 'Remove filter',
        operator: 'Filter operator',
        compare: 'Compare against',
        now: /* @wc-include */ 'now',
        date: /* @wc-include */ 'a date',
        value: 'Filter value',
        unavailable: 'This column is unavailable.',
      }}
      renderValueInput={
        column
          ? state => <TableFilterValueInput property={column} {...state} />
          : undefined
      }
      renderValueSummary={value =>
        value.startsWith('http') || isAtomicIdentifier(value) ? (
          <ResourceInline subject={value} untabbable />
        ) : (
          <span>{unit?.suffix ? `${value} ${unit.suffix}` : value}</span>
        )
      }
      hint={
        viewKind === 'calendar' &&
        (column?.datatype === Datatype.DATE ||
          column?.datatype === Datatype.TIMESTAMP)
          ? "This filters on each entry's own date. A repeating entry is matched on its first date, not on the days it repeats on."
          : undefined
      }
    />
  );
}
