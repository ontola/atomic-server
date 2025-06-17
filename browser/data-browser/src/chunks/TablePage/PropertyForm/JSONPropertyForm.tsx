import { Datatype, core } from '@tomic/react';
import { useEffect, type JSX } from 'react';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';

export function JSONPropertyForm({
  resource,
}: PropertyCategoryFormProps): JSX.Element {
  useEffect(() => {
    resource.set(core.properties.datatype, Datatype.JSON);
  }, []);

  return <></>;
}
