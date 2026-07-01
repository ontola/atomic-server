import { Property, useResource, useTitle } from '@tomic/react';
import { useContext, useState, type JSX } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import { Popover } from '@components/Popover';
import { Row, Column } from '@components/Row';
import { BasicSelect } from '@components/forms/BasicSelect';
import { ResourceInline } from '@views/ResourceInline';
import { TablePageContext } from './tablePageContext';
import {
  TableFilter,
  FilterOperator,
  operatorLabelForColumn,
  operatorsForDatatype,
} from './tableFiltering';
import { TableFilterValueInput } from './TableFilterValueInput';

interface TableFilterChipProps {
  filter: TableFilter;
  column: Property;
}

export function TableFilterChip({
  filter,
  column,
}: TableFilterChipProps): JSX.Element {
  const { setFilterValue, setFilterOperator, removeFilter } =
    useContext(TablePageContext);
  const propResource = useResource(column.subject);
  const [title] = useTitle(propResource);
  // Newly added filters (no value yet) open their editor straight away.
  const [open, setOpen] = useState(filter.value === '');

  const label = title || column.shortname;
  const operators = operatorsForDatatype(column.datatype);
  const chipOperator = operatorLabelForColumn(filter.operator, column.datatype);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      Trigger={
        <ChipTrigger $active={filter.value !== ''}>
          <ChipLabel>{label}</ChipLabel>
          <ChipOperator>{chipOperator}</ChipOperator>
          <ChipValue>
            {filter.value === '' ? (
              <Placeholder>…</Placeholder>
            ) : (
              <FilterValueSummary value={filter.value} />
            )}
          </ChipValue>
        </ChipTrigger>
      }
    >
      <PopoverInner>
        <Row center justify='space-between' gap='1rem'>
          <Header>{label}</Header>
          <RemoveButton
            onClick={() => removeFilter(filter.property)}
            title='Remove filter'
            type='button'
          >
            <FaXmark />
          </RemoveButton>
        </Row>
        {operators.length > 1 && (
          <BasicSelect
            value={filter.operator}
            aria-label='Filter operator'
            onChange={e =>
              setFilterOperator(
                filter.property,
                e.target.value as FilterOperator,
              )
            }
          >
            {operators.map(op => (
              <option key={op} value={op}>
                {operatorLabelForColumn(op, column.datatype)}
              </option>
            ))}
          </BasicSelect>
        )}
        <TableFilterValueInput
          property={column}
          value={filter.value}
          autoFocus
          onChange={value => setFilterValue(filter.property, value)}
        />
      </PopoverInner>
    </Popover>
  );
}

/** Renders the chosen value: a resource link for references, raw text else. */
function FilterValueSummary({ value }: { value: string }): JSX.Element {
  if (value.startsWith('http') || value.startsWith('did:')) {
    return <ResourceInline subject={value} untabbable />;
  }

  return <span>{value}</span>;
}

const ChipTrigger = styled(RadixPopover.Trigger)<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 24rem;
  padding: 0.1rem 0.5rem;
  height: 1.75rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p =>
    p.$active ? p.theme.colors.bg1 : p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  cursor: pointer;
  font-size: 0.85rem;
  white-space: nowrap;

  &:hover {
    border-color: ${p => p.theme.colors.main};
  }
`;

const ChipLabel = styled.span`
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ChipOperator = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const ChipValue = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
`;

const Placeholder = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const PopoverInner = styled(Column)`
  padding: ${p => p.theme.size()};
  gap: ${p => p.theme.size()};
  min-width: 18rem;
`;

const Header = styled.span`
  font-weight: bold;
`;

const RemoveButton = styled.button`
  background: none;
  border: none;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 0.25rem;
  border-radius: ${p => p.theme.radius};

  &:hover {
    color: ${p => p.theme.colors.alert};
    background-color: ${p => p.theme.colors.bg1};
  }
`;
