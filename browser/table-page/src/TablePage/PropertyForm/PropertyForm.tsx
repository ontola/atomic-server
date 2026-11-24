import { core, Resource, unknownSubject, useString } from '@tomic/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type JSX,
} from 'react';
import { styled } from 'styled-components';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { useValidation } from '@tomic/resource-ui/components/forms/formValidation/useValidation';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { stringToSlug } from '@tomic/resource-ui/helpers/stringToSlug';
import { categoryFormFactory, PropertyFormCategory } from './categories.js';

interface PropertyFormProps {
  onSubmit: () => void;
  resource: Resource;
  category?: PropertyFormCategory;
  existingProperty?: boolean;
  autoFocusName?: boolean;
  disabled?: boolean;
}

export function PropertyForm({
  resource,
  onSubmit,
  existingProperty,
  category,
  autoFocusName,
  disabled,
}: PropertyFormProps): JSX.Element {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const nameErrorId = `${nameId}-error`;
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
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) {
        return;
      }

      const value = e.target.value;

      setName(value);

      // The shortname is part of the property's identity, so it only follows
      // the name while the property is being created. Renaming an existing
      // property changes the label only.
      if (!existingProperty) {
        setShortName(stringToSlug((value ?? '').trim()));
      }
    },
    [setName, setShortName, existingProperty, disabled],
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

  useEffect(() => {
    if (!autoFocusName) {
      return;
    }

    const timeout = window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [autoFocusName, resource.subject]);

  const CategoryForm = categoryFormFactory(category);

  return (
    <Form onSubmit={handleSubmit}>
      <div>
        <InputWrapper $invalid={!!nameError}>
          <InputStyled
            ref={nameInputRef}
            id={nameId}
            type='text'
            aria-label='Column name'
            aria-invalid={!!nameError}
            aria-describedby={nameError ? nameErrorId : undefined}
            disabled={disabled}
            autoFocus={autoFocusName}
            data-dialog-autofocus={autoFocusName ? true : undefined}
            value={name ?? ''}
            onChange={handleNameChange}
            placeholder='New Column'
            onFocus={autoFocusName ? e => e.currentTarget.select() : undefined}
            onBlur={setNameTouched}
          />
        </InputWrapper>
        {nameError && (
          <ErrorChip id={nameErrorId} role='alert'>
            {nameError}
          </ErrorChip>
        )}
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
