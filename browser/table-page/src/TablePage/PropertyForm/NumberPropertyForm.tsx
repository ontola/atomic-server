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
import { RadioGroup, RadioInput } from '@tomic/ui/components/forms/RadioInput';
import { FormGroupHeading } from './FormGroupHeading.js';
import { DecimalPlacesInput } from './Inputs/DecimalPlacesInput.js';
import { TableRangeInput } from './Inputs/TableRangeInput.js';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps.js';

const { numberFormats } = urls.instances;
const CurrencyPicker = lazy(
  () => import('@tomic/resource-ui/chunks/CurrencyPicker/CurrencyPicker'),
);

export const NumberPropertyForm = ({
  resource,
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

    // If decimal places is not set yet we assume it is a new property and should default to float.
    if (decimalPlaces === undefined) {
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
        name='number-format'
        value={numberFormatting}
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
        allowFractions
      />
    </Suspense>
  );
};
