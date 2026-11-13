import { core, Resource, unknownSubject, useString } from '@tomic/react';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  forwardRef,
  type InputHTMLAttributes,
  type JSX,
} from 'react';
import { TablePropertyForm, nameTableProperty } from '@tomic/table';
import { ErrorChip } from '@components/forms/ErrorChip';
import { useValidation } from '@components/forms/formValidation/useValidation';
import { FormValidationContext } from '@components/forms/formValidation/FormValidationContextProvider';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { stringToSlug } from '@helpers/stringToSlug';
import { categoryFormFactory, PropertyFormCategory } from './categories';

interface PropertyFormProps {
  onSubmit: () => void;
  resource: Resource;
  category?: PropertyFormCategory;
  existingProperty?: boolean;
  autoFocusName?: boolean;
  disabled?: boolean;
}

const PropertyNameInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>((props, ref) => (
  <InputWrapper $invalid={props['aria-invalid'] === true}>
    <InputStyled {...props} ref={ref} />
  </InputWrapper>
));

export function PropertyForm({
  resource,
  onSubmit,
  existingProperty,
  category,
  autoFocusName,
  disabled,
}: PropertyFormProps): JSX.Element {
  const { validations } = useContext(FormValidationContext);
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
    <TablePropertyForm
      onSubmit={onSubmit}
      disabled={disabled}
      valid={!Object.values(validations).some(error => error !== undefined)}
      name={{
        Input: PropertyNameInput,
        Error: ErrorChip,
        value: name ?? '',
        onChange: handleNameChange,
        autoFocus: autoFocusName,
        label: 'Column name',
        placeholder: 'New Column',
        onBlur: setNameTouched,
        error: nameError,
      }}
    >
      <CategoryForm resource={resource} existingProperty={existingProperty} />
    </TablePropertyForm>
  );
}
