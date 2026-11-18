import {
  useEffect,
  useRef,
  type ComponentType,
  type Ref,
  type InputHTMLAttributes,
} from 'react';

export interface PropertyNameFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  /** Preserve the original form's focus reset when its resource changes. */
  focusKey?: string;
  placeholder?: string;
  Input?: ComponentType<
    InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }
  >;
}

/** Existing input and delayed focus behavior; the host retains its error UI. */
export function PropertyNameField({
  value,
  onChange,
  onBlur,
  autoFocus,
  focusKey,
  placeholder = 'New Column',
  Input,
}: PropertyNameFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const Component = Input ?? 'input';

  useEffect(() => {
    if (!autoFocus) return;
    const timeout = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [autoFocus, focusKey]);

  return (
    <Component
      ref={ref}
      id='name-form'
      type='text'
      autoFocus={autoFocus}
      data-dialog-autofocus={autoFocus ? true : undefined}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      onFocus={autoFocus ? event => event.currentTarget.select() : undefined}
      onBlur={onBlur}
    />
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
