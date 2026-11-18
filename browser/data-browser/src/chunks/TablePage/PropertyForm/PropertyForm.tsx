import { core, Resource, unknownSubject, useString } from '@tomic/react';
import { useCallback, useEffect, useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { PropertyNameField, nameTableProperty } from '@tomic/table';
import { ErrorChip } from '@components/forms/ErrorChip';
import { useValidation } from '@components/forms/formValidation/useValidation';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { stringToSlug } from '@helpers/stringToSlug';
import { categoryFormFactory, PropertyFormCategory } from './categories';

interface PropertyFormProps {
  onSubmit: () => void;
  resource: Resource;
  category?: PropertyFormCategory;
  existingProperty?: boolean;
  autoFocusName?: boolean;
}

export function PropertyForm({
  resource,
  onSubmit,
  existingProperty,
  category,
  autoFocusName,
}: PropertyFormProps): JSX.Element {
  const {
    error: nameError,
    setError: setNameError,
    setTouched: setNameTouched,
  } = useValidation('Required');

  const valueOptions = useMemo(
    () => ({
      handleValidationError(e: Error | undefined) {
        if (e) {
          setNameError('Invalid Name');
        } else {
          setNameError(undefined);
        }
      },
    }),
    [setNameError],
  );

  const [name, setName] = useString(
    resource,
    core.properties.name,
    valueOptions,
  );
  const [shortname, setShortName] = useString(
    resource,
    core.properties.shortname,
    valueOptions,
  );

  const handleNameChange = useCallback(
    (value: string) => {
      const next = nameTableProperty(
        {
          name: name ?? '',
          shortname: shortname ?? '',
          existing: !!existingProperty,
        },
        value,
        stringToSlug,
      );
      setName(next.name);
      if (!existingProperty) setShortName(next.shortname);
    },
    [name, shortname, setName, setShortName, existingProperty],
  );

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = useCallback(
    e => {
      e.preventDefault();
      onSubmit();
    },
    [onSubmit],
  );

  // Clear validation error if name is already set (pre-filled or existing property).
  useEffect(() => {
    if (
      resource.subject !== unknownSubject &&
      existingProperty &&
      !name &&
      shortname
    ) {
      setName(shortname);
      setNameError(undefined);
    }

    if (name) {
      setNameError(undefined);
    }
  }, []);

  const CategoryForm = categoryFormFactory(category);

  return (
    <Form onSubmit={handleSubmit}>
      <div>
        <InputWrapper $invalid={!!nameError}>
          <PropertyNameField
            Input={InputStyled}
            focusKey={resource.subject}
            autoFocus={autoFocusName}
            value={name ?? ''}
            onChange={handleNameChange}
            placeholder='New Column'
            onBlur={setNameTouched}
          />
        </InputWrapper>
        {nameError && <ErrorChip>{nameError}</ErrorChip>}
      </div>
      <CategoryForm resource={resource} existingProperty={existingProperty} />
      {/* Needed for inputs to submit on enter */}
      <HiddenSubmitButton type='submit' />
    </Form>
  );
}

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const HiddenSubmitButton = styled.button`
  display: none;
`;
