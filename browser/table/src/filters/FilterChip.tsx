import { useState, type ReactNode } from 'react';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import { Popover, PopoverTrigger } from '@tomic/ui/components/Popover';
import { Row, Column } from '@tomic/ui/components/Row';
import { BasicSelect } from '@tomic/ui/components/forms/BasicSelect';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { tableTheme } from '../theme.js';
import type {
  TableFilter,
  TableFilterOperator,
} from '../views/configuration.js';

export interface TableFilterChipProps {
  filter: TableFilter;
  label: string;
  operatorLabel: string;
  operators: readonly { value: TableFilterOperator; label: string }[];
  onValueChange: (value: string) => void;
  onOperatorChange: (operator: TableFilterOperator) => void;
  onRemove: () => void;
  derivedUnit?: { suffix: string; allowsNow: boolean };
  renderValueInput: (state: {
    value: string;
    onChange: (value: string) => void;
    autoFocus: boolean;
  }) => ReactNode;
  renderValueSummary: (value: string, suffix?: string) => ReactNode;
  hint?: ReactNode;
  messages?: Partial<{
    remove: string;
    operator: string;
    compare: string;
    now: string;
    date: string;
  }>;
}

/** Existing filter-chip presentation. Metadata and reference lookup remain host-bound. */
export function TableFilterChip({
  filter,
  label,
  operatorLabel,
  operators,
  onValueChange,
  onOperatorChange,
  onRemove,
  derivedUnit,
  renderValueInput,
  renderValueSummary,
  hint,
  messages,
}: TableFilterChipProps) {
  const [open, setOpen] = useState(filter.value === '');
  const text = {
    remove: 'Remove filter',
    operator: 'Filter operator',
    compare: 'Compare against',
    now: 'now',
    date: 'a date',
    ...messages,
  };

  return (
    <Popover
      updatePositionStrategy='always'
      open={open}
      onOpenChange={setOpen}
      Trigger={
        <ChipTrigger $active={filter.value !== ''} data-testid='filter-chip'>
          <ChipLabel>{label}</ChipLabel>
          <ChipOperator>{operatorLabel}</ChipOperator>
          <ChipValue>
            {filter.value === '' ? (
              <Placeholder>…</Placeholder>
            ) : (
              renderValueSummary(filter.value, derivedUnit?.suffix)
            )}
          </ChipValue>
        </ChipTrigger>
      }
    >
      <PopoverInner>
        <Row center justify='space-between' gap='1rem'>
          <Header>{label}</Header>
          <RemoveButton
            onClick={() => onRemove()}
            title={text.remove}
            type='button'
          >
            <FaXmark />
          </RemoveButton>
        </Row>
        {operators.length > 1 && (
          <BasicSelect
            value={filter.operator}
            aria-label={text.operator}
            onChange={event =>
              onOperatorChange(event.target.value as TableFilterOperator)
            }
          >
            {operators.map(operator => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </BasicSelect>
        )}
        {derivedUnit ? (
          <Column gap='0.5rem'>
            {derivedUnit.allowsNow && (
              <BasicSelect
                aria-label={text.compare}
                value={filter.value === 'now' ? 'now' : 'date'}
                onChange={event =>
                  onValueChange(event.target.value === 'now' ? 'now' : '')
                }
              >
                <option value='now'>{text.now}</option>
                <option value='date'>{text.date}</option>
              </BasicSelect>
            )}
            {filter.value !== 'now' && (
              <Row center gap='0.5ch'>
                <InputWrapper>
                  <InputStyled
                    autoFocus
                    data-testid='derived-filter-value'
                    onChange={event => onValueChange(event.target.value)}
                    placeholder={derivedUnit.allowsNow ? 'yyyy-mm-dd' : '0'}
                    step='any'
                    type={derivedUnit.allowsNow ? 'date' : 'number'}
                    value={filter.value}
                  />
                </InputWrapper>
                {derivedUnit.suffix && <Suffix>{derivedUnit.suffix}</Suffix>}
              </Row>
            )}
          </Column>
        ) : (
          renderValueInput({
            value: filter.value,
            onChange: onValueChange,
            autoFocus: true,
          })
        )}
        {hint && <ScopeHint>{hint}</ScopeHint>}
      </PopoverInner>
    </Popover>
  );
}

const Suffix = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
  font-size: 0.85rem;
  white-space: nowrap;
`;

const ChipTrigger = styled(PopoverTrigger)<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 24rem;
  padding: 0.1rem 0.5rem;
  height: 1.75rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background-color: ${p =>
    p.$active ? tableTheme(p.theme).colors.bg1 : tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
  cursor: pointer;
  font-size: 0.85rem;
  white-space: nowrap;

  &:hover {
    border-color: ${p => tableTheme(p.theme).colors.main};
  }
`;

const ChipLabel = styled.span`
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ChipOperator = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
`;

const ChipValue = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
`;

const Placeholder = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
`;

const PopoverInner = styled(Column)`
  padding: ${p => tableTheme(p.theme).size()};
  gap: ${p => tableTheme(p.theme).size()};
  min-width: 18rem;
`;

const Header = styled.span`
  font-weight: bold;
`;

const RemoveButton = styled.button`
  background: none;
  border: none;
  color: ${p => tableTheme(p.theme).colors.textLight};
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 0.25rem;
  border-radius: ${p => tableTheme(p.theme).radius};

  &:hover {
    color: ${p => tableTheme(p.theme).colors.alert};
    background-color: ${p => tableTheme(p.theme).colors.bg1};
  }
`;

const ScopeHint = styled.p`
  margin: 0;
  max-width: 18rem;
  font-size: 0.8rem;
  color: ${p => tableTheme(p.theme).colors.textLight};
`;
