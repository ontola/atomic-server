import {
  core,
  properties,
  useCanWrite,
  useResource,
  useString,
} from '@tomic/react';
import {
  TableColumnRemovalDialog,
  executeTableColumnRemoval,
} from '@tomic/table';
import { ResourceInline } from '@views/ResourceInline';
import { ResourceUsage } from '@components/ResourceUsage';

export interface AtomicColumnRemovalDialogProps {
  owner: string;
  property: string;
  currentOwner: string;
  onClose: () => void;
}

/** Metadata/services adapter. The shared dialog owns pending/error/intent state. */
export function AtomicColumnRemovalDialog({
  owner,
  property,
  currentOwner,
  onClose,
}: AtomicColumnRemovalDialogProps) {
  const tableClass = useResource(owner);
  const resource = useResource(property);
  const [parent] = useString(resource, properties.parent);
  const canWriteClass = useCanWrite(tableClass);
  const canWriteProperty = useCanWrite(resource);
  const canRemove = currentOwner === owner && canWriteClass;
  const canDeleteDefinition = parent === owner && canWriteProperty;

  return (
    <TableColumnRemovalDialog
      scope={JSON.stringify([owner, property])}
      canRemove={canRemove}
      canDeleteDefinition={canDeleteDefinition}
      onClose={onClose}
      onConfirm={deleteDefinition =>
        executeTableColumnRemoval(
          { deleteDefinition, canRemove, canDeleteDefinition },
          {
            removeFromSchema: async () => {
              const recommends = tableClass.getArray(
                core.properties.recommends,
              ) as string[];
              const requires = tableClass.getArray(
                core.properties.requires,
              ) as string[];
              await tableClass.set(
                core.properties.recommends,
                recommends.filter(subject => subject !== property),
              );
              await tableClass.set(
                core.properties.requires,
                requires.filter(subject => subject !== property),
              );
              await tableClass.save();
            },
            deleteDefinition: () => resource.destroy(),
          },
        )
      }
      messages={{
        removeTitle: 'Remove column',
        deleteTitle: 'Delete property',
        deleteDefinition: 'Delete property and its children',
        remove: 'Remove',
        delete: 'Delete',
        cancel: 'Cancel',
        pending: 'Removing column…',
        unavailable:
          'Column removal is unavailable. Check access and the selected table.',
      }}
    >
      <p>
        Remove <ResourceInline subject={property} /> from{' '}
        <ResourceInline subject={owner} />
      </p>
      <ResourceUsage resource={resource} />
    </TableColumnRemovalDialog>
  );
}
