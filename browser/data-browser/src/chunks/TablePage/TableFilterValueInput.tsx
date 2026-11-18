import { Datatype, Property, server } from '@tomic/react';
import { type JSX } from 'react';
import {
  TableFilterValueInput as SharedFilterValueInput,
  type TableFilterValueKind,
} from '@tomic/table';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { BasicSelect } from '@components/forms/BasicSelect';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { TagOption } from './RowActionDialog';

interface TableFilterValueInputProps {
  property: Property;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}
const FilterTagOption = ({ value }: { value: string }) => (
  <TagOption subject={value} />
);

/** Atomic supplies datatype IDs, tag labels, resource search and form styling.
 * The actual typed filter UI and blur policy live in the shared page package. */
export function TableFilterValueInput({
  property,
  value,
  onChange,
  autoFocus,
}: TableFilterValueInputProps): JSX.Element {
  const messages = {
    any: /* @wc-include */ 'Any',
    true: /* @wc-include */ 'True',
    false: /* @wc-include */ 'False',
    pickOption: /* @wc-include */ 'Pick an option…',
    value: /* @wc-include */ 'Value…',
  };

  const datatype = property.datatype;
  const reference =
    datatype === Datatype.ATOMIC_URL || datatype === Datatype.RESOURCEARRAY;
  const kind: TableFilterValueKind = reference
    ? 'reference'
    : datatype === Datatype.BOOLEAN
      ? 'boolean'
      : datatype === Datatype.INTEGER || datatype === Datatype.FLOAT
        ? 'number'
        : datatype === Datatype.DATE
          ? 'date'
          : datatype === Datatype.JSON
            ? 'json'
            : 'text';

  return (
    <SharedFilterValueInput
      kind={kind}
      value={value}
      onChange={onChange}
      autoFocus={autoFocus}
      label='Filter value'
      normalizeNumbers
      messages={messages}
      choices={property.allowsOnly}
      Option={FilterTagOption}
      Input={InputStyled}
      Select={BasicSelect}
      Wrapper={InputWrapper}
      referenceInput={
        reference
          ? state => (
              <ResourceSelector
                value={state.value || undefined}
                isA={
                  property.classType === server.classes.file
                    ? undefined
                    : property.classType
                }
                hideCreateOption
                autoFocus={state.autoFocus}
                disabled={state.disabled}
                setSubject={subject => state.onChange(subject ?? '')}
              />
            )
          : undefined
      }
    />
  );
}
