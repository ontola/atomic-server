import { Checkbox } from '@components/forms/Checkbox';
import {
  core,
  useArray,
  useMemberFromCollection,
  type Collection,
} from '@tomic/react';
import { ResourceInline } from '@views/ResourceInline';
interface PermissionRowProps {
  collection: Collection;
  index: number;
  pluginAgent: string;
  onReadUpdate: () => void;
}

export const PermissionRow = ({
  collection,
  index,
  pluginAgent,
  onReadUpdate,
}: PermissionRowProps) => {
  const resource = useMemberFromCollection(collection, index);
  const [reads] = useArray(resource, core.properties.read);
  const [writes] = useArray(resource, core.properties.write);

  const isRead = reads.includes(pluginAgent);
  const isWrite = writes.includes(pluginAgent);

  const changeRead = async (checked: boolean) => {
    if (checked) {
      resource.push(core.properties.read, [pluginAgent], true);
    } else {
      await resource.set(
        core.properties.read,
        reads.filter(agent => agent !== pluginAgent),
      );

      if (isWrite) {
        await resource.set(
          core.properties.write,
          writes.filter(agent => agent !== pluginAgent),
        );
      }
    }

    await resource.save();
    onReadUpdate();
  };

  const changeWrite = async (checked: boolean) => {
    if (checked) {
      if (!isRead) {
        resource.push(core.properties.read, [pluginAgent], true);
      }

      resource.push(core.properties.write, [pluginAgent], true);
    } else {
      await resource.set(
        core.properties.write,
        writes.filter(agent => agent !== pluginAgent),
      );
    }

    await resource.save();
  };

  return (
    <tr>
      <td>
        <ResourceInline subject={resource.subject} />
      </td>
      <td>
        <Checkbox onChange={changeRead} checked={isRead} />
      </td>
      <td>
        <Checkbox onChange={changeWrite} checked={isWrite} />
      </td>
    </tr>
  );
};
