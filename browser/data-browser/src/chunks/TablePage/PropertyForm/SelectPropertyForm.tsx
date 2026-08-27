import {
  Datatype,
  Resource,
  core,
  dataBrowser,
  useArray,
  useStore,
} from '@tomic/react';
import { useCallback, useEffect, type JSX } from 'react';
import { Row } from '@components/Row';
import { PropertyCategoryFormProps } from './PropertyCategoryFormProps';
import { CreateTagRow, EditableTag } from '@components/Tag';

const valueOpts = {
  commit: false,
  validate: false,
};

export function SelectPropertyForm({
  resource,
}: PropertyCategoryFormProps): JSX.Element {
  const store = useStore();

  const [allowOnly, , pushAllowOnly, removeAllowOnly] = useArray(
    resource,
    core.properties.allowsOnly,
    valueOpts,
  );

  const handleNewTag = useCallback(
    async (tag: Resource) => {
      pushAllowOnly([tag.subject]);

      await tag.save();
    },
    [pushAllowOnly],
  );

  const handleDeleteTag = useCallback(
    async (subject: string) => {
      const tag = store.getResourceLoading(subject);
      tag.destroy();

      removeAllowOnly([subject]);
    },
    [store, removeAllowOnly],
  );

  useEffect(() => {
    resource.addClasses(dataBrowser.classes.selectProperty);

    resource.set(core.properties.datatype, Datatype.RESOURCEARRAY);
    resource.set(core.properties.classtype, dataBrowser.classes.tag);
  }, []);

  return (
    <>
      <Row wrapItems>
        {allowOnly.map(tag => (
          <EditableTag subject={tag} key={tag} onDelete={handleDeleteTag} />
        ))}
      </Row>
      <CreateTagRow parent={resource.subject} onNewTag={handleNewTag} />
    </>
  );
}
