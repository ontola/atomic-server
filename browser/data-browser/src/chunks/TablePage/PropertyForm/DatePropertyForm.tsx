import { Datatype, core, dataBrowser, urls, useString } from '@tomic/react';
import { Suspense, useEffect, useState, type JSX } from 'react';
import { TablePropertyFields } from '@tomic/table';
import { Checkbox } from '@components/forms/Checkbox';
import { DateFormatPicker } from './Inputs/DateFormatPicker';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';

export function DatePropertyForm({
  resource,
}: PropertyCategoryFormProps): JSX.Element {
  const [includeTime, setIncludeTime] = useState(
    resource.get(core.properties.datatype) === Datatype.TIMESTAMP,
  );
  const [dateFormat, setDateFormat] = useString(
    resource,
    urls.properties.constraints.dateFormat,
  );

  useEffect(() => {
    const type = includeTime ? Datatype.TIMESTAMP : Datatype.DATE;

    (async () => {
      await resource.set(core.properties.datatype, type);
      await resource.set(core.properties.isA, [
        dataBrowser.classes.formattedDate,
      ]);

      if (dateFormat === undefined) {
        await resource.set(
          dataBrowser.properties.dateFormat,
          urls.instances.dateFormats.localNumeric,
        );
      }
    })();
  }, [dateFormat, includeTime]);

  return (
    <Suspense>
      <TablePropertyFields
        messages={{ includeTime: 'Include Time' }}
        model={{
          kind: 'date',
          includeTime,
          onIncludeTimeChange: setIncludeTime,
          Checkbox,
          formats: (
            <DateFormatPicker
              value={dateFormat}
              onChange={setDateFormat}
              withTime={includeTime}
            />
          ),
        }}
      />
    </Suspense>
  );
}
