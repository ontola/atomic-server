import { useValue } from '@tomic/react';
import { InputProps } from './ResourceField';
import { styled } from 'styled-components';
import { ErrorChipInput } from './ErrorChip';
import {
  checkForInitialRequiredValue,
  useValidation,
} from './formValidation/useValidation';
import { JSONEditor } from '../JSONEditor';
import { JSON_RENDERER_CLASS } from '../datatypes/JSON';

export const InputJSON: React.FC<InputProps> = ({
  resource,
  property,
  commit,
  commitDebounceInterval,
  autoFocus,
  ...props
}) => {
  const [value, setValue] = useValue(resource, property.subject, {
    commit,
    commitDebounce: commitDebounceInterval,
    validate: false,
  });

  const { error, setError, setTouched } = useValidation(
    checkForInitialRequiredValue(value, props.required),
  );

  function handleUpdate(content: string): void {
    if (content === '') {
      setValue(undefined);
      setError(undefined);

      return;
    }

    try {
      const parsed = JSON.parse(content);
      setValue(parsed);
      setError(undefined);
    } catch (e) {
      setError('Invalid JSON');
    }
  }

  const initialValue = JSON.stringify(value, null, 2);

  return (
    <Wrapper className={JSON_RENDERER_CLASS}>
      <JSONEditor
        initialValue={initialValue}
        autoFocus={autoFocus}
        onChange={handleUpdate}
        onBlur={setTouched}
        showErrorStyling={!!error}
        onValidationChange={valid => {
          setError(valid ? undefined : 'Invalid JSON');
        }}
      />
      {error && <ErrorChipInput top='100%'>{error}</ErrorChipInput>}
    </Wrapper>
  );
};

const Wrapper = styled.div`
  flex: 1;
  position: relative;
`;
