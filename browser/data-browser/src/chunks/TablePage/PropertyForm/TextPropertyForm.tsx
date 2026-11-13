import { Datatype, core, dataBrowser } from '@tomic/react';
import { useState, type JSX } from 'react';
import { TablePropertyFields } from '@tomic/table';
import { RadioGroup, RadioInput } from '@components/forms/RadioInput';
import { FormGroupHeading } from './FormGroupHeading';
import { TableRangeInput } from './Inputs/TableRangeInput';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';

export const TextPropertyForm = ({
  resource,
}: PropertyCategoryFormProps): JSX.Element => {
  const [textFormat, setTextFormat] = useState<Datatype>(
    resource.props.datatype as Datatype,
  );

  const handleTextFormatChange = async (value: string) => {
    setTextFormat(value as Datatype);

    await resource.set(core.properties.datatype, value, false);
  };

  return (
    <TablePropertyFields
      Heading={FormGroupHeading}
      messages={{ textFormat: 'Text Format:', length: 'Length' }}
      model={{
        kind: 'text',
        format: {
          label: 'Text format',
          value: textFormat,
          onChange: handleTextFormatChange,
          Radio: RadioInput,
          Group: RadioGroup,
          options: [
            { value: Datatype.STRING, label: 'Plain text' },
            { value: Datatype.MARKDOWN, label: 'Rich text' },
            { value: Datatype.SLUG, label: 'Slug' },
            { value: Datatype.URI, label: 'URI' },
          ],
        },
        range: (
          <TableRangeInput
            resource={resource}
            minProp={dataBrowser.properties.min}
            maxProp={dataBrowser.properties.max}
          />
        ),
      }}
    />
  );
};
