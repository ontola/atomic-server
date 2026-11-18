import {
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import {
  PropertyNameField,
  type PropertyNameFieldProps,
} from './PropertyNameField.js';
import {
  PropertyChoiceField,
  type PropertyChoiceFieldProps,
} from './PropertyChoiceField.js';

export interface TablePropertyFormProps extends PropsWithChildren {
  name: PropertyNameFieldProps;
  valid?: boolean;
  disabled?: boolean;
  onSubmit: () => void;
}

/** Actual common form submission/name layout. Category metadata controllers
 * compose TablePropertyFields below; persistence belongs to the enclosing dialog. */
export function TablePropertyForm({
  name,
  valid = true,
  disabled,
  onSubmit,
  children,
}: TablePropertyFormProps) {
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (valid && !disabled) onSubmit();
      }}
    >
      <Fields disabled={disabled} inert={disabled}>
        <div>
          <PropertyNameField {...name} disabled={disabled || name.disabled} />
        </div>
        {children}
        <button
          type='submit'
          disabled={disabled || !valid}
          style={{ display: 'none' }}
        />
      </Fields>
    </form>
  );
}

export interface TablePropertyCheckboxProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}
type CheckboxComponent = ComponentType<TablePropertyCheckboxProps>;
type Category =
  | { kind: 'text'; format: PropertyChoiceFieldProps; range: ReactNode }
  | {
      kind: 'number';
      format: PropertyChoiceFieldProps;
      currencyFormat: string;
      currency: ReactNode;
      precision: ReactNode;
      range: ReactNode;
    }
  | {
      kind: 'date';
      includeTime: boolean;
      onIncludeTimeChange: (value: boolean) => void;
      formats: ReactNode;
      Checkbox?: CheckboxComponent;
    }
  | {
      kind: 'relation';
      selector: ReactNode;
      multiple: boolean;
      onMultipleChange: (value: boolean) => void;
      Checkbox?: CheckboxComponent;
    }
  | { kind: 'select'; options: readonly ReactNode[]; createOption: ReactNode }
  | { kind: 'none' | 'unknown' };

export type TablePropertyFieldsModel = Category;
export interface TablePropertyFieldsProps {
  model: TablePropertyFieldsModel;
  disabled?: boolean;
  Heading?: ComponentType<PropsWithChildren>;
  messages?: Partial<{
    textFormat: string;
    length: string;
    numberFormat: string;
    range: string;
    includeTime: string;
    resourceType: string;
    multiple: string;
    noType: string;
  }>;
}

function DefaultCheckbox({
  checked,
  disabled,
  onChange,
}: TablePropertyCheckboxProps) {
  return (
    <input
      type='checkbox'
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
    />
  );
}

/** Category UI from the actual property form. Values, validation and mutation
 * policies come from metadata controllers. Resource/currency/tag selectors are
 * backend leaves; the shared range/precision/date controls can be adapted there. */
export function TablePropertyFields(props: TablePropertyFieldsProps) {
  return (
    <fieldset
      disabled={props.disabled}
      inert={props.disabled}
      style={{
        border: 0,
        padding: 0,
        margin: 0,
        minWidth: 0,
        display: 'contents',
      }}
    >
      <PropertyFieldsBody {...props} />
    </fieldset>
  );
}

function PropertyFieldsBody({
  model,
  disabled,
  Heading = GroupHeading,
  messages,
}: TablePropertyFieldsProps) {
  const text = {
    textFormat: 'Text Format:',
    length: 'Length',
    numberFormat: 'Number Format',
    range: 'Range',
    includeTime: 'Include Time',
    resourceType: 'Resource type:',
    multiple: 'Allow multiple values',
    noType: 'No Type selected',
    ...messages,
  };

  switch (model.kind) {
    case 'text':
      return (
        <>
          <Heading>{text.textFormat}</Heading>
          <PropertyChoiceField
            {...model.format}
            disabled={disabled || model.format.disabled}
          />
          <Heading>{text.length}</Heading>
          {model.range}
        </>
      );
    case 'number':
      return (
        <>
          <Heading>{text.numberFormat}</Heading>
          <PropertyChoiceField
            {...model.format}
            disabled={disabled || model.format.disabled}
          />
          {model.format.value === model.currencyFormat
            ? model.currency
            : model.precision}
          <Heading>{text.range}</Heading>
          {model.range}
        </>
      );

    case 'date': {
      const Checkbox = model.Checkbox ?? DefaultCheckbox;

      return (
        <>
          <Toggle>
            <Checkbox
              checked={model.includeTime}
              disabled={disabled}
              onChange={value => {
                if (!disabled) model.onIncludeTimeChange(value);
              }}
            />
            <span>{text.includeTime}</span>
          </Toggle>
          {model.formats}
        </>
      );
    }

    case 'relation': {
      const Checkbox = model.Checkbox ?? DefaultCheckbox;

      return (
        <>
          <ResourceLabel>
            <strong>{text.resourceType}</strong>
            {model.selector}
          </ResourceLabel>
          <Toggle>
            <Checkbox
              checked={model.multiple}
              disabled={disabled}
              onChange={value => {
                if (!disabled) model.onMultipleChange(value);
              }}
            />
            {text.multiple}
          </Toggle>
        </>
      );
    }

    case 'select':
      return (
        <>
          <Options>{model.options}</Options>
          {model.createOption}
        </>
      );
    case 'unknown':
      return <span>{text.noType}</span>;
    case 'none':
      return null;
  }
}

const Fields = styled.fieldset`
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;
const GroupHeading = styled.h2`
  font-size: 1.1rem;
  margin-bottom: 0.2rem;
  font-weight: bold;
`;
const Toggle = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;
const ResourceLabel = styled.label`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  cursor: pointer;
`;
const Options = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
`;
