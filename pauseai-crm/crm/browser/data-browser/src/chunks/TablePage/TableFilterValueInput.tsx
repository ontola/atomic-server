import { Datatype, Property, server } from '@tomic/react';
import { type JSX } from 'react';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { BasicSelect } from '@components/forms/BasicSelect';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';

interface TableFilterValueInputProps {
  property: Property;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/**
 * Datatype-aware editor for a single filter value. References and resource
 * arrays use the resource search box; everything else gets a fitting plain
 * input. The value is always serialised to a string (matching the query
 * param + `contains_value`'s string comparison).
 */
export function TableFilterValueInput({
  property,
  value,
  onChange,
  autoFocus,
}: TableFilterValueInputProps): JSX.Element {
  const datatype = property.datatype;

  if (datatype === Datatype.ATOMIC_URL || datatype === Datatype.RESOURCEARRAY) {
    return (
      <ResourceSelector
        value={value || undefined}
        isA={
          property.classType === server.classes.file
            ? undefined
            : property.classType
        }
        hideCreateOption
        autoFocus={autoFocus}
        setSubject={subject => onChange(subject ?? '')}
      />
    );
  }

  if (datatype === Datatype.BOOLEAN) {
    return (
      <BasicSelect
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
      >
        <option value=''>Any</option>
        <option value='true'>True</option>
        <option value='false'>False</option>
      </BasicSelect>
    );
  }

  const inputType =
    datatype === Datatype.INTEGER || datatype === Datatype.FLOAT
      ? 'number'
      : datatype === Datatype.DATE
        ? 'date'
        : 'text';

  return (
    <InputWrapper>
      <InputStyled
        type={inputType}
        value={value}
        autoFocus={autoFocus}
        placeholder='Value…'
        onChange={e => onChange(e.target.value)}
      />
    </InputWrapper>
  );
}
