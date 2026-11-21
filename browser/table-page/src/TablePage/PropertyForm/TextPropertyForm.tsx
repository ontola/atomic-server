import { Datatype, core, dataBrowser } from '@tomic/react';
import { useState, type JSX } from 'react';
import { PropertyChoiceField } from '@tomic/table';
import { RadioGroup, RadioInput } from '@tomic/ui/components/forms/RadioInput';
import { FormGroupHeading } from './FormGroupHeading.js';
import { TableRangeInput } from './Inputs/TableRangeInput.js';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps.js';

export const TextPropertyForm = ({
  resource,
}: PropertyCategoryFormProps): JSX.Element => {
  const [textFormat, setTextFormat] = useState<Datatype>(
    resource.props.datatype as Datatype,
  );

  const handleTextFormatChange = async (value: string) => {
    setTextFormat(value as Datatype);

    await resource.set(core.properties.datatype, value, false);
    await resource.save();
  };

  return (
    <>
      <FormGroupHeading>Text Format:</FormGroupHeading>
      <PropertyChoiceField
        name='text-format'
        value={textFormat}
        onChange={handleTextFormatChange}
        Radio={RadioInput}
        Group={RadioGroup}
        options={[
          { value: Datatype.STRING, label: 'Plain text' },
          { value: Datatype.MARKDOWN, label: 'Rich text' },
          { value: Datatype.SLUG, label: 'Slug' },
          { value: Datatype.URI, label: 'URI' },
        ]}
      />
      <FormGroupHeading>Length</FormGroupHeading>
      <TableRangeInput
        resource={resource}
        minProp={dataBrowser.properties.min}
        maxProp={dataBrowser.properties.max}
      />
    </>
  );
};
