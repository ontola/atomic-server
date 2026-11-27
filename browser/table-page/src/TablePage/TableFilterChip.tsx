import {
  Datatype,
  Property,
  core,
  isAtomicIdentifier,
  unknownSubject,
  useResource,
  useString,
} from '@tomic/react';
import { columnLabel } from '@tomic/resource-ui/helpers/columnLabel';
import { useContext, type JSX } from 'react';
import { TableFilterChip as SharedFilterChip } from '@tomic/table';
import { ResourceInline } from '@tomic/resource-ui/views/ResourceInline/index';
import { TablePageContext } from './tablePageContext.js';
import {
  DERIVED_FILTER_OPERATORS,
  derivedFilterUnit,
  filterKey,
  operatorLabel,
  operatorLabelForColumn,
  operatorsForDatatype,
  type TableFilter,
} from './tableFiltering.js';
import type { DerivedColumnSpec } from './derivedColumns.js';
import { TableFilterValueInput } from './TableFilterValueInput.js';

interface TableFilterChipProps {
  filter: TableFilter;
  /** The stored column this constrains, when it constrains one. */
  column?: Property;
  /** The computed column this constrains instead. Exactly one of the two. */
  derived?: DerivedColumnSpec;
  disabled?: boolean;
}

export function TableFilterChip({
  filter,
  column,
  derived,
  disabled,
}: TableFilterChipProps): JSX.Element {
  const { setFilterValue, setFilterOperator, removeFilter, viewKind } =
    useContext(TablePageContext);
  // A computed column has no property resource to read a title from.
  const propResource = useResource(column?.subject ?? unknownSubject);
  const [name] = useString(propResource, core.properties.name);
  const key = filterKey(filter);

  const unavailable = !column && !derived;
  const label = derived
    ? derived.label
    : column
      ? columnLabel(name, column.shortname)
      : 'Unavailable column';
  const operators = derived
    ? DERIVED_FILTER_OPERATORS
    : column
      ? operatorsForDatatype(column.datatype)
      : [];
  const chipOperator =
    derived || unavailable
      ? operatorLabel(filter.operator)
      : operatorLabelForColumn(filter.operator, column!.datatype);
  const unit = derived ? derivedFilterUnit(derived) : undefined;

  return (
    <SharedFilterChip
      filter={filter}
      label={label}
      operatorLabel={chipOperator}
      operators={operators.map(value => ({
        value,
        label: derived
          ? operatorLabel(value)
          : operatorLabelForColumn(value, column!.datatype),
      }))}
      disabled={disabled}
      unavailable={unavailable}
      onValueChange={value => setFilterValue(key, value)}
      onOperatorChange={operator => setFilterOperator(key, operator)}
      onRemove={() => removeFilter(key)}
      derivedUnit={derived ? unit : undefined}
      renderValueInput={state => (
        <TableFilterValueInput property={column!} {...state} normalizeNumbers />
      )}
      renderValueSummary={(value, suffix) => (
        <FilterValueSummary value={value} suffix={suffix} />
      )}
      messages={{
        remove: 'Remove filter',
        operator: 'Filter operator',
        compare: 'Compare against',
        now: /* @wc-include */ 'now',
        date: /* @wc-include */ 'a date',
        value: 'Filter value',
        unavailable: 'This column is unavailable.',
      }}
      hint={
        viewKind === 'calendar' &&
        (column?.datatype === Datatype.DATE ||
          column?.datatype === Datatype.TIMESTAMP) ? (
          <>
            This filters on each entry's own date. A repeating entry is matched
            on its first date, not on the days it repeats on.
          </>
        ) : undefined
      }
    />
  );
}

/** Renders the chosen value: a resource link for references, raw text else. */
function FilterValueSummary({
  value,
  suffix,
}: {
  value: string;
  suffix?: string;
}): JSX.Element {
  if (value.startsWith('http') || isAtomicIdentifier(value)) {
    return <ResourceInline subject={value} untabbable />;
  }

  return <span>{suffix ? `${value} ${suffix}` : value}</span>;
}
