import {
  useState,
  useId,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import type { TableFilter } from '../views/configuration.js';
import type { TableFilterOperator } from '../query.js';
import { tableTheme } from '../theme.js';
import {
  TableFilterValueInput,
  type TableFilterValueInputProps,
} from './FilterValueInput.js';

export interface TableFilterPopoverProps {
  Trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updatePositionStrategy?: 'optimized' | 'always';
  labelledBy?: string;
}
export interface TableFilterChipProps {
  filter: TableFilter;
  label: string;
  operatorLabel: string;
  operators: readonly { value: TableFilterOperator; label: string }[];
  onValueChange: (value: string) => void;
  onOperatorChange: (operator: TableFilterOperator) => void;
  onRemove: () => void;
  onOpenChange?: (open: boolean) => void;
  /** Backend value adapter: Atomic uses the same shared value control, with
   * property metadata, tag labels and its reference-search leaf. */
  renderValueInput?: (state: {
    value: string;
    onChange: (value: string) => void;
    autoFocus: boolean;
  }) => ReactNode;
  valueInputProps?: Omit<
    TableFilterValueInputProps,
    'value' | 'onChange' | 'autoFocus'
  >;
  derivedUnit?: { suffix: string; allowsNow: boolean };
  renderValueSummary?: (value: string) => ReactNode;
  hint?: ReactNode;
  unavailable?: boolean;
  disabled?: boolean;
  Popover?: ComponentType<PropsWithChildren<TableFilterPopoverProps>>;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Select?: ComponentType<SelectHTMLAttributes<HTMLSelectElement>>;
  Wrapper?: ComponentType<PropsWithChildren>;
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
const defaults = {
  remove: 'Remove filter',
  operator: 'Filter operator',
  compare: 'Compare against',
  now: 'now',
  date: 'a date',
  value: 'Filter value',
  unavailable: 'This column is unavailable.',
};

/** Actual TablePage filter-chip UI: open/edit/remove state, numeric/date modes
 * and operator selection are shared; storage and reference identity stay out. */
export function TableFilterChip({
  filter,
  label,
  operatorLabel,
  operators,
  onValueChange,
  onOperatorChange,
  onRemove,
  onOpenChange,
  renderValueInput,
  valueInputProps,
  derivedUnit,
  renderValueSummary,
  hint,
  unavailable,
  disabled,
  Popover = DefaultPopover,
  Input,
  Select,
  Wrapper,
  messages,
}: TableFilterChipProps) {
  const [open, setOpen] = useState(filter.value === '');
  const titleId = useId();
  const text = { ...defaults, ...messages };
  const SelectComponent = Select ?? DefaultSelect;
  const InputComponent = Input ?? DefaultInput;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const input = (
    <InputComponent
      autoFocus
      disabled={disabled}
      aria-label={text.value}
      data-testid='derived-filter-value'
      placeholder={derivedUnit?.allowsNow ? 'yyyy-mm-dd' : '0'}
      inputMode={derivedUnit?.allowsNow ? undefined : 'decimal'}
      type={derivedUnit?.allowsNow ? 'date' : 'text'}
      value={filter.value}
      onChange={event => onValueChange(event.target.value)}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={changeOpen}
      updatePositionStrategy='always'
      labelledBy={titleId}
      Trigger={
        <ChipTrigger
          type='button'
          disabled={disabled}
          $active={filter.value !== ''}
          data-testid='filter-chip'
        >
          <ChipLabel>{label}</ChipLabel>
          <Muted>{operatorLabel}</Muted>
          <ChipValue>
            {filter.value === '' ? (
              <Muted>…</Muted>
            ) : renderValueSummary ? (
              renderValueSummary(filter.value)
            ) : (
              <>
                {filter.value}
                {derivedUnit?.suffix ? ` ${derivedUnit.suffix}` : ''}
              </>
            )}
          </ChipValue>
        </ChipTrigger>
      }
    >
      <Inner>
        <HeaderRow>
          <strong id={titleId}>{label}</strong>
          <RemoveButton
            type='button'
            disabled={disabled}
            onClick={() => {
              changeOpen(false);
              onRemove();
            }}
            title={text.remove}
            aria-label={text.remove}
          >
            <FaXmark />
          </RemoveButton>
        </HeaderRow>
        {unavailable ? (
          <Hint>{text.unavailable}</Hint>
        ) : (
          <>
            {(operators.length > 1 ||
              !operators.some(option => option.value === filter.operator)) && (
              <SelectComponent
                disabled={disabled}
                aria-label={text.operator}
                value={filter.operator}
                onChange={event => {
                  const operator = operators.find(
                    option => option.value === event.target.value,
                  );
                  if (operator) onOperatorChange(operator.value);
                }}
              >
                {!operators.some(
                  operator => operator.value === filter.operator,
                ) && (
                  <option value={filter.operator} disabled>
                    {operatorLabel}
                  </option>
                )}
                {operators.map(operator => (
                  <option key={operator.value} value={operator.value}>
                    {operator.label}
                  </option>
                ))}
              </SelectComponent>
            )}
            {derivedUnit ? (
              <>
                {derivedUnit.allowsNow && (
                  <SelectComponent
                    disabled={disabled}
                    aria-label={text.compare}
                    value={filter.value === 'now' ? 'now' : 'date'}
                    onChange={event =>
                      onValueChange(event.target.value === 'now' ? 'now' : '')
                    }
                  >
                    <option value='now'>{text.now}</option>
                    <option value='date'>{text.date}</option>
                  </SelectComponent>
                )}
                {!(derivedUnit.allowsNow && filter.value === 'now') && (
                  <ValueRow>
                    {Wrapper ? <Wrapper>{input}</Wrapper> : input}
                    {derivedUnit.suffix && (
                      <Suffix>{derivedUnit.suffix}</Suffix>
                    )}
                  </ValueRow>
                )}
              </>
            ) : renderValueInput ? (
              renderValueInput({
                value: filter.value,
                onChange: value => {
                  if (!disabled) onValueChange(value);
                },
                autoFocus: true,
              })
            ) : (
              <TableFilterValueInput
                Input={InputComponent}
                Select={SelectComponent}
                {...(valueInputProps ?? { kind: 'text' })}
                disabled={disabled || valueInputProps?.disabled}
                label={valueInputProps?.label ?? text.value}
                value={filter.value}
                onChange={onValueChange}
                autoFocus
              />
            )}
            {hint && <Hint>{hint}</Hint>}
          </>
        )}
      </Inner>
    </Popover>
  );
}

function DefaultPopover({
  Trigger,
  open,
  onOpenChange,
  updatePositionStrategy,
  labelledBy,
  children,
}: PropsWithChildren<TableFilterPopoverProps>) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      {Trigger}
      <RadixPopover.Portal>
        <Content
          aria-labelledby={labelledBy}
          collisionPadding={10}
          sticky='always'
          updatePositionStrategy={updatePositionStrategy}
        >
          {children}
          <Arrow />
        </Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

const Content = styled(RadixPopover.Content)`
  font:
    0.875rem/1.5 system-ui,
    sans-serif;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
  box-shadow: ${p => tableTheme(p.theme).boxShadowIntense};
  z-index: 10000000;
`;
const Arrow = styled(RadixPopover.Arrow)`
  fill: ${p => tableTheme(p.theme).colors.bg};
`;
const ChipTrigger = styled(RadixPopover.Trigger)<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 24rem;
  padding: 0.1rem 0.5rem;
  height: 1.75rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p =>
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
const Muted = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
`;
const ChipValue = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
`;
const Inner = styled.div`
  display: flex;
  flex-direction: column;
  padding: max(0.75rem, ${p => tableTheme(p.theme).size()});
  gap: max(0.5rem, ${p => tableTheme(p.theme).size()});
  min-width: 18rem;
  max-width: calc(100vw - 2rem);
  box-sizing: border-box;
`;
const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
`;
const ValueRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5ch;
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
    background: ${p => tableTheme(p.theme).colors.bg1};
  }
`;
const Hint = styled.p`
  margin: 0;
  max-width: 18rem;
  font-size: 0.8rem;
  color: ${p => tableTheme(p.theme).colors.textLight};
`;
const Suffix = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
  font-size: 0.85rem;
  white-space: nowrap;
`;

const DefaultInput = styled.input`
  font: inherit;
  color: inherit;
  background: ${p => tableTheme(p.theme).colors.bg};
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  min-height: 2.25rem;
  padding: 0.35rem 0.6rem;
  min-width: 0;
  width: 100%;
`;
const DefaultSelect = styled.select`
  font: inherit;
  color: inherit;
  background: ${p => tableTheme(p.theme).colors.bg};
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  min-height: 2.25rem;
  padding: 0.35rem 0.6rem;
  min-width: 0;
  width: 100%;
`;
