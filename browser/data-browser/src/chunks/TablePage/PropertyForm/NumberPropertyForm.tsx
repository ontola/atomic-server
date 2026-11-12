import {
  Datatype,
  core,
  dataBrowser,
  urls,
  useNumber,
  useString,
} from '@tomic/react';
import { Suspense, lazy, useEffect, type JSX } from 'react';
import { PropertyChoiceField } from '@tomic/table';
import { RadioGroup, RadioInput } from '@components/forms/RadioInput';
import { FormGroupHeading } from './FormGroupHeading';
import { DecimalPlacesInput } from './Inputs/DecimalPlacesInput';
import { TableRangeInput } from './Inputs/TableRangeInput';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';

const { numberFormats } = urls.instances;
const CurrencyPicker = lazy(
  () => import('../../../chunks/CurrencyPicker/CurrencyPicker'),
);

export const NumberPropertyForm = ({
  resource,
  existingProperty,
}: PropertyCategoryFormProps): JSX.Element => {
  const [numberFormatting, setNumberFormatting] = useString(
    resource,
    dataBrowser.properties.numberFormatting,
  );

  const [decimalPlaces] = useNumber(
    resource,
    dataBrowser.properties.decimalPlaces,
  );

  const [_, setDataType] = useString(resource, core.properties.datatype);

  const handleNumberFormatChange = async (value: string) => {
    setNumberFormatting(value);

    if (value === numberFormats.currency) {
      await resource.addClasses(dataBrowser.classes.currencyProperty);
      await setDataType(Datatype.FLOAT);
    } else {
      resource.removeClasses(dataBrowser.classes.currencyProperty);
      resource.remove(dataBrowser.properties.currency);
    }
  };

  useEffect(() => {
    resource.addClasses(dataBrowser.classes.formattedNumber);

    // A missing display precision does not change an existing property identity.
    // Only new number drafts default to float.
    if (!existingProperty && decimalPlaces === undefined) {
      resource.set(core.properties.datatype, Datatype.FLOAT);
    }

    if (numberFormatting === undefined) {
      setNumberFormatting(numberFormats.number);
    }
  }, []);

  return (
    <Suspense fallback={<div>loading...</div>}>
      <FormGroupHeading>Number Format</FormGroupHeading>
      <PropertyChoiceField
        label='Number format'
        value={numberFormatting ?? numberFormats.number}
        onChange={handleNumberFormatChange}
        Radio={RadioInput}
        Group={RadioGroup}
        options={[
          { value: numberFormats.number, label: 'Number' },
          { value: numberFormats.percentage, label: 'Percentage' },
          { value: numberFormats.currency, label: 'Currency' },
        ]}
      />
      {/* Follows the chosen format, not the class: adding the class is async and
       *  does not re-render, so a new column never got its currency picker. */}
      {numberFormatting === numberFormats.currency ? (
        <CurrencyPicker resource={resource} />
      ) : (
        <DecimalPlacesInput resource={resource} />
      )}
      <FormGroupHeading>Range</FormGroupHeading>
      <TableRangeInput
        resource={resource}
        minProp={dataBrowser.properties.min}
        maxProp={dataBrowser.properties.max}
      />
    </Suspense>
  );
};
