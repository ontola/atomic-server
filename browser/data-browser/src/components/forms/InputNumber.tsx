import { Datatype, useNumber } from '@tomic/react';
import { InputProps } from './ResourceField';
import { InputStyled, InputWrapper } from './InputStyles';
import { useValidatedInput } from './formValidation/useValidatedInput';
import { ErrorChipInput } from './ErrorChip';
import { styled } from 'styled-components';

import type { JSX } from 'react';

export default function InputNumber({
  resource,
  property,
  commit,
  commitDebounceInterval,
  required,
  ...props
}: InputProps): JSX.Element {
  const [value, setValue] = useNumber(resource, property.subject, {
    validate: false,
    commit,
    commitDebounce: commitDebounceInterval,
  });

  const { error, setTouched, update } = useValidatedInput(value, setValue, {
    datatype: property.datatype,
    required,
  });

  function handleUpdate(e: React.ChangeEvent<HTMLInputElement>) {
    update(e.target.value === '' ? undefined : +e.target.value);
  }

  return (
    <Wrapper>
      <InputWrapper $invalid={!!error}>
        <InputStyled
          placeholder='Enter a number...'
          type='number'
          value={value === undefined ? '' : Number.isNaN(value) ? '' : value}
          step={property.datatype === Datatype.INTEGER ? 1 : 'any'}
          onChange={handleUpdate}
          onBlur={setTouched}
          required={required}
          {...props}
        />
      </InputWrapper>
      {error && <ErrorChipInput top='2rem'>{error}</ErrorChipInput>}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  flex: 1;
  width: fit-content;
  position: relative;
`;
