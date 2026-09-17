import { useState, type JSX } from 'react';
import { useBoolean } from '@tomic/react';
import { InputProps } from './ResourceField';
import { ErrMessage } from './InputStyles';
import { Checkbox } from './Checkbox';

export default function InputBoolean({
  resource,
  property,
  commit,
  commitDebounceInterval,
  required: _required,
  ...props
}: InputProps): JSX.Element {
  const [err, setErr] = useState<Error | undefined>(undefined);
  const [value, setValue] = useBoolean(resource, property.subject, {
    handleValidationError: setErr,
    commit,
    commitDebounce: commitDebounceInterval,
  });

  return (
    <>
      <Checkbox checked={value ?? false} onChange={setValue} {...props} />
      {err && <ErrMessage>{err.message}</ErrMessage>}
    </>
  );
}
