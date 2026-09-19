import { InputProps } from './ResourceField';
import { useValidatedInput } from './formValidation/useValidatedInput';
import { styled } from 'styled-components';
import { ErrorChipInput } from './ErrorChip';
import { useString } from '@tomic/react';
import { InputStyled, InputWrapper } from './InputStyles';
import { ChangeEvent } from 'react';

export function InputDate({
  resource,
  property,
  commit,
  commitDebounceInterval,
  required,
  ...props
}: InputProps): React.JSX.Element {
  const [value, setValue] = useString(resource, property.subject, {
    commit,
    commitDebounce: commitDebounceInterval,
    validate: false,
  });

  const { error, setTouched, update } = useValidatedInput(value, setValue, {
    datatype: property.datatype,
    required,
  });

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    // A cleared date input yields '', which is "no date", not an invalid one.
    update(event.target.value === '' ? undefined : event.target.value);
  };

  return (
    <Wrapper>
      <StyledInputWrapper $invalid={!!error}>
        <InputStyled
          type='date'
          value={value ?? ''}
          onChange={handleChange}
          onBlur={setTouched}
          required={required}
          {...props}
        />
      </StyledInputWrapper>
      {error && <ErrorChipInput>{error}</ErrorChipInput>}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  position: relative;
`;

const StyledInputWrapper = styled(InputWrapper)`
  width: min-content;
`;
