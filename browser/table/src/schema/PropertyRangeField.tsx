import { useEffect, useEffectEvent, useId, useState } from 'react';
import {
  parseFloatText,
  parseInteger,
} from '../chunks/TablePage/EditorCells/numberInput.js';
import { UNPARSED } from '../chunks/TablePage/EditorCells/useCommittedText.js';
import type { PropertyNameFieldProps } from './PropertyNameField.js';

export function parsePropertyRange(
  minText: string,
  maxText: string,
  integers = false,
  nonNegative = false,
) {
  const parse = integers ? parseInteger : parseFloatText;
  const min = parse(minText),
    max = parse(maxText);
  if (min === UNPARSED || max === UNPARSED)
    return { error: integers ? ('integer' as const) : ('number' as const) };
  if (
    nonNegative &&
    ((min !== undefined && min < 0) || (max !== undefined && max < 0))
  )
    return { error: 'nonNegative' as const };
  if (min !== undefined && max !== undefined && min > max)
    return { error: 'order' as const };

  return { min, max, error: undefined };
}

const messages = {
  integer: 'Enter whole numbers or leave the bounds empty.',
  number: 'Enter finite numbers or leave the bounds empty.',
  nonNegative: 'Bounds cannot be negative.',
  order: 'Minimum must not exceed maximum.',
};

export interface PropertyRangeFieldProps {
  messages?: Partial<typeof messages>;
  minValue?: number;
  maxValue?: number;
  integers?: boolean;
  nonNegative?: boolean;
  disabled?: boolean;
  minLabel?: string;
  maxLabel?: string;
  onBlur?: () => void;
  onChange: (min: number | undefined, max: number | undefined) => void;
  onValidationError?: (error: string | undefined) => void;
  Input?: PropertyNameFieldProps['Input'];
  Error?: PropertyNameFieldProps['Error'];
}

/** A schema-draft field: invalid raw input is retained, and never coerced into a
 * different bound. Remount for a different draft/schema revision. No persistence. */
export function PropertyRangeField({
  minValue,
  maxValue,
  integers = false,
  nonNegative = false,
  disabled,
  minLabel = 'Minimum',
  maxLabel = 'Maximum',
  onBlur,
  onChange,
  onValidationError,
  Input,
  Error,
  messages: localized,
}: PropertyRangeFieldProps) {
  const [text, setText] = useState(() => ({
    min: minValue === undefined ? '' : String(minValue),
    max: maxValue === undefined ? '' : String(maxValue),
  }));
  const id = useId();
  const result = parsePropertyRange(text.min, text.max, integers, nonNegative);
  const error = result.error
    ? (localized?.[result.error] ?? messages[result.error])
    : undefined;
  const reportError = useEffectEvent((reported: string | undefined) =>
    onValidationError?.(reported),
  );
  useEffect(() => {
    reportError(error);
  }, [error]);
  const Component = Input ?? 'input';
  const ErrorMessage = Error ?? 'span';

  const change = (which: 'min' | 'max', value: string) => {
    const next = { ...text, [which]: value };
    setText(next);
    const parsed = parsePropertyRange(
      next.min,
      next.max,
      integers,
      nonNegative,
    );
    if (parsed.error === undefined) onChange(parsed.min, parsed.max);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Component
          type='text'
          inputMode={integers ? 'numeric' : 'decimal'}
          aria-label={minLabel}
          aria-invalid={!!result.error}
          aria-describedby={result.error ? id : undefined}
          placeholder='min'
          value={text.min}
          disabled={disabled}
          onBlur={onBlur}
          onChange={event => change('min', event.target.value)}
        />
        <span aria-hidden='true'>–</span>
        <Component
          type='text'
          inputMode={integers ? 'numeric' : 'decimal'}
          aria-label={maxLabel}
          aria-invalid={!!result.error}
          aria-describedby={result.error ? id : undefined}
          placeholder='max'
          value={text.max}
          disabled={disabled}
          onBlur={onBlur}
          onChange={event => change('max', event.target.value)}
        />
      </div>
      {result.error && (
        <ErrorMessage id={id} role='alert'>
          {error}
        </ErrorMessage>
      )}
    </div>
  );
}
