import { useEffect, useEffectEvent, useId, useState } from 'react';
import { parseInteger } from '../chunks/TablePage/EditorCells/numberInput.js';
import { UNPARSED } from '../chunks/TablePage/EditorCells/useCommittedText.js';
import type { PropertyNameFieldProps } from './PropertyNameField.js';

export interface PropertyPrecisionFieldProps {
  value?: number;
  label?: string;
  invalidMessage?: string;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
  onValidationError?: (error: string | undefined) => void;
  onBlur?: () => void;
  Input?: PropertyNameFieldProps['Input'];
  Error?: PropertyNameFieldProps['Error'];
}

/** Display precision draft. Invalid raw text never changes precision or datatype.
 * Remount for another property/draft, as with PropertyRangeField. */
export function PropertyPrecisionField({
  value,
  label = 'Decimal Places',
  invalidMessage = 'Enter a whole number between 0 and 20, or leave empty.',
  disabled,
  onChange,
  onValidationError,
  onBlur,
  Input,
  Error,
}: PropertyPrecisionFieldProps) {
  const [text, setText] = useState(() =>
    value === undefined ? '' : String(value),
  );
  const id = useId();
  const parsed = parseInteger(text);
  const invalid =
    parsed === UNPARSED ||
    (parsed !== undefined && (parsed < 0 || parsed > 20));
  const error = invalid ? invalidMessage : undefined;
  const report = useEffectEvent(() => onValidationError?.(error));
  useEffect(() => {
    report();
  }, [error]);
  const Field = Input ?? 'input';
  const ErrorMessage = Error ?? 'span';

  return (
    <div>
      <label
        htmlFor={id}
        style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}
      >
        {label}
      </label>
      <Field
        id={id}
        type='text'
        inputMode='numeric'
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onBlur={onBlur}
        onChange={event => {
          if (disabled) return;
          const raw = event.target.value;
          setText(raw);
          const next = parseInteger(raw);
          if (
            next !== UNPARSED &&
            (next === undefined || (next >= 0 && next <= 20))
          )
            onChange(next);
        }}
      />
      {error && (
        <ErrorMessage id={`${id}-error`} role='alert'>
          {error}
        </ErrorMessage>
      )}
    </div>
  );
}
