import { Datatype, core, server } from '@tomic/react';
import { useEffect, type JSX } from 'react';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps.js';

export function FilePropertyForm({
  resource,
}: PropertyCategoryFormProps): JSX.Element {
  useEffect(() => {
    resource.set(core.properties.datatype, Datatype.ATOMIC_URL);
    resource.set(core.properties.classtype, server.classes.file);
  }, []);

  return <></>;
}
