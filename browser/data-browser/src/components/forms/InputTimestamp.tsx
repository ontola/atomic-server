import { useNumber } from '@tomic/react';
import { InputProps } from './ResourceField';
import { useValidatedInput } from './formValidation/useValidatedInput';
import { styled } from 'styled-components';
import { ErrorChipInput } from './ErrorChip';
import { InputStyled, InputWrapper } from './InputStyles';
import { useDateTimeInput } from './hooks/useDateTimeInput';

export function InputTimestamp({
  resource,
  property,
  commit,
  commitDebounceInterval,
  required,
  ...props
}: InputProps): React.JSX.Element {
  const [value, setValue] = useNumber(resource, property.subject, {
    commit,
    commitDebounce: commitDebounceInterval,
    validate: false,
  });

  const { error, setTouched, update } = useValidatedInput(value, setValue, {
    datatype: property.datatype,
    required,
  });

  // `useDateTimeInput` parses the `datetime-local` string into a timestamp (or
  // `undefined` when cleared) before it reaches the validated setter.
  const [localDate, handleChange] = useDateTimeInput(value, update);

  return (
    <Wrapper>
      <StyledInputWrapper $invalid={!!error}>
        <InputStyled
          type='datetime-local'
          value={localDate ?? ''}
          required={required}
          onChange={handleChange}
          onBlur={setTouched}
          {...props}
        />
      </StyledInputWrapper>
      {error && <ErrorChipInput>{error}</ErrorChipInput>}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  flex: 1;
  position: relative;
`;

const StyledInputWrapper = styled(InputWrapper)`
  width: min-content;
`;
