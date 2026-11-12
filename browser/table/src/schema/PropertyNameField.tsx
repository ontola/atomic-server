import {
  useEffect,
  useId,
  useRef,
  type ComponentType,
  type Ref,
  type ReactNode,
  type InputHTMLAttributes,
} from 'react';

export interface PropertyNameFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  /** Host styling only; identity and persistence never pass through the input. */
  Error?: ComponentType<{ id: string; role: 'alert'; children: ReactNode }>;
  Input?: ComponentType<
    InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }
  >;
}

/** The same controlled name field is used for Atomic and native schema drafts.
 * Invalid names remain editable; submission is the enclosing form's decision. */
export function PropertyNameField({
  value,
  onChange,
  onBlur,
  error,
  autoFocus,
  disabled,
  label = 'Column name',
  placeholder = 'New Column',
  Input,
  Error: ErrorComponent,
}: PropertyNameFieldProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const Component = Input ?? 'input';
  const ErrorMessage = ErrorComponent ?? 'span';
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [autoFocus]);

  return (
    <>
      <Component
        ref={ref}
        id={id}
        type='text'
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? id + '-error' : undefined}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-dialog-autofocus={autoFocus ? true : undefined}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
        onFocus={autoFocus ? event => event.currentTarget.select() : undefined}
      />
      {error && (
        <ErrorMessage id={id + '-error'} role='alert'>
          {error}
        </ErrorMessage>
      )}
    </>
  );
}

/** Existing property identity is immutable when only its display label changes.
 * New properties may derive a provisional shortname before identity is minted. */
export function nameTableProperty(
  current: { name: string; shortname: string; existing: boolean },
  name: string,
  slug: (name: string) => string,
) {
  return {
    ...current,
    name,
    shortname: current.existing ? current.shortname : slug(name.trim()),
  };
}
