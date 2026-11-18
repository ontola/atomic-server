import { useString } from '@tomic/react';
import { InputProps } from './ResourceField.js';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { styled } from 'styled-components';
import { ErrorChipInput } from './ErrorChip.js';
import { useValidatedInput } from './formValidation/useValidatedInput.js';

import type { JSX } from 'react';

export default function InputURI({
  resource,
  property,
  commit,
  commitDebounceInterval,
  required,
  ...props
}: InputProps): JSX.Element {
  const [value, setValue] = useString(resource, property.subject, {
    commit,
    commitDebounce: commitDebounceInterval,
    validate: false,
  });

  const { error, setTouched, update } = useValidatedInput(value, setValue, {
    datatype: property.datatype,
    required,
  });

  function handleUpdate(event: React.ChangeEvent<HTMLInputElement>): void {
    update(event.target.value);
  }

  return (
    <Wrapper>
      <InputWrapper $invalid={!!error}>
        <InputStyled
          type='url'
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
          value={value === undefined ? '' : value}
          onChange={handleUpdate}
          required={required}
          {...props}
          onBlur={setTouched}
        />
      </InputWrapper>
      {error && <ErrorChipInput>{error}</ErrorChipInput>}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  flex: 1;
  position: relative;
`;
