import { useCanWrite, useResource } from '@tomic/react';
import { EditPropertyDialog } from './PropertyForm/EditPropertyDialog';

/** Stable page placement keeps editor/error state alive through schema updates. */
export function AtomicColumnEditDialog({
  owner,
  property,
  currentOwner,
  onClose,
}: {
  owner: string;
  property: string;
  currentOwner: string;
  onClose: () => void;
}) {
  const resource = useResource(property);
  const canWrite = useCanWrite(resource);

  return (
    <EditPropertyDialog
      resource={resource}
      tableClassSubject={owner}
      showDialog
      bindShow={show => {
        if (!show) onClose();
      }}
      canSave={canWrite && owner === currentOwner}
    />
  );
}
