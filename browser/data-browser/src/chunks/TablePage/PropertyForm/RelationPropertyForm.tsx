import { Datatype, core, useString } from '@tomic/react';
import { useEffect, type JSX } from 'react';
import { TablePropertyFields } from '@tomic/table';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';
import { Checkbox } from '@components/forms/Checkbox';

const valueOpts = { commit: false };

const RELATION_TYPES = new Set<string>([
  Datatype.RESOURCEARRAY,
  Datatype.ATOMIC_URL,
]);

export function RelationPropertyForm({
  resource,
}: PropertyCategoryFormProps): JSX.Element {
  const [classType, setClassType] = useString(
    resource,
    core.properties.classtype,
    valueOpts,
  );

  const [datatype, setDatatype] = useString(resource, core.properties.datatype);

  const handleAllowMultiple = (checked: boolean) => {
    if (checked) {
      setDatatype(Datatype.RESOURCEARRAY);
    } else {
      setDatatype(Datatype.ATOMIC_URL);
    }
  };

  useEffect(() => {
    if (!RELATION_TYPES.has(resource.props.datatype)) {
      setDatatype(Datatype.ATOMIC_URL);
    }
  }, [setDatatype]);

  return (
    <TablePropertyFields
      messages={{
        resourceType: 'Resource type:',
        multiple: 'Allow multiple values',
      }}
      model={{
        kind: 'relation',
        multiple: datatype === Datatype.RESOURCEARRAY,
        onMultipleChange: handleAllowMultiple,
        Checkbox,
        selector: (
          <ResourceSelector
            isA={core.classes.class}
            value={classType}
            setSubject={setClassType}
          />
        ),
      }}
    />
  );
}
