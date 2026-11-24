import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  /** Lock an open editor while its host is performing a conflicting operation. */
  disabled?: boolean;
  unavailable?: boolean;
  derivedUnit?: { suffix: string; allowsNow: boolean };
  renderValueInput: (state: {
    value: string;
    onChange: (value: string) => void;
    autoFocus: boolean;
    disabled?: boolean;
  }) => ReactNode;
  renderValueSummary: (value: string, suffix?: string) => ReactNode;
  hint?: ReactNode;
  messages?: Partial<{
    remove: string;
    operator: string;
    compare: string;
    now: string;
    date: string;
    value: string;
    unavailable: string;
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
  disabled,
  unavailable,
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
    value: 'Filter value',
    unavailable: 'This column is unavailable.',
    ...messages,
  };
  const supportedOperator = operators.some(
    operator => operator.value === filter.operator,
  );

  const changeValue = useFilterValueChange(
    onValueChange,
    disabled || unavailable,
  );

  return (
    <Popover
      updatePositionStrategy='always'
      open={open}
      onOpenChange={next => {
        if (!next || !disabled) setOpen(next);
      }}
      Trigger={
        <ChipTrigger
          type='button'
          disabled={disabled}
          $active={filter.value !== ''}
          data-testid='filter-chip'
        >
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
            disabled={disabled}
            onClick={() => {
              if (!disabled) onRemove();
            }}
            title={text.remove}
            type='button'
          >
            <FaXmark />
          </RemoveButton>
        </Row>
        {unavailable ? (
          <ScopeHint>{text.unavailable}</ScopeHint>
        ) : (
          <>
            {(operators.length > 1 || !supportedOperator) && (
              <BasicSelect
                disabled={disabled}
                value={filter.operator}
                aria-label={text.operator}
                onChange={event => {
                  const operator = operators.find(
                    option => option.value === event.target.value,
                  );
                  if (!disabled && !unavailable && operator)
                    onOperatorChange(operator.value);
                }}
              >
                {!supportedOperator && (
                  <option value={filter.operator} disabled>
                    {operatorLabel}
                  </option>
                )}
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
                    disabled={disabled}
                    aria-label={text.compare}
                    value={filter.value === 'now' ? 'now' : 'date'}
                    onChange={event =>
                      changeValue(event.target.value === 'now' ? 'now' : '')
                    }
                  >
                    <option value='now'>{text.now}</option>
                    <option value='date'>{text.date}</option>
                  </BasicSelect>
                )}
                {!(derivedUnit.allowsNow && filter.value === 'now') && (
                  <Row center gap='0.5ch'>
                    <InputWrapper>
                      <InputStyled
                        autoFocus
                        disabled={disabled}
                        aria-label={text.value}
                        data-testid='derived-filter-value'
                        onChange={event => changeValue(event.target.value)}
                        placeholder={derivedUnit.allowsNow ? 'yyyy-mm-dd' : '0'}
                        step='any'
                        type={
                          derivedUnit.allowsNow
                            ? 'date'
                            : filter.value.trim() === '' ||
                                Number.isFinite(Number(filter.value))
                              ? 'number'
                              : 'text'
                        }
                        inputMode={
                          derivedUnit.allowsNow ? undefined : 'decimal'
                        }
                        value={filter.value}
                      />
                    </InputWrapper>
                    {derivedUnit.suffix && (
                      <Suffix>{derivedUnit.suffix}</Suffix>
                    )}
                  </Row>
                )}
              </Column>
            ) : (
              renderValueInput({
                value: filter.value,
                onChange: changeValue,
                autoFocus: true,
                disabled,
              })
            )}
            {hint && <ScopeHint>{hint}</ScopeHint>}
          </>
        )}
      </PopoverInner>
    </Popover>
  );
}

/** Hosts can retain an editor callback while their pending operation changes
 * the controls. Resolve its lock and destination at event time. */
function useFilterValueChange(
  onChange: (value: string) => void,
  disabled?: boolean,
) {
  const state = useRef({ onChange, disabled });
  useLayoutEffect(() => {
    state.current = { onChange, disabled };
  }, [onChange, disabled]);

  return useCallback((value: string) => {
    if (!state.current.disabled) state.current.onChange(value);
  }, []);
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
