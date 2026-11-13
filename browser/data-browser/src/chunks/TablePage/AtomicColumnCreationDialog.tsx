import { useCanWrite, useResource } from '@tomic/react';
import { NewPropertyDialog } from './PropertyForm/NewPropertyDialog';

/** The request retains table/view/class ownership above grid headers. */
export function AtomicColumnCreationDialog({
  owner,
  category,
  scope,
  canSave,
  onClose,
  onCreated,
}: {
  owner: string;
  category: string;
  scope: string;
  canSave: boolean;
  onClose: () => void;
  onCreated: (subject: string) => void;
}) {
  const tableClass = useResource(owner);
  const canWrite = useCanWrite(tableClass);

  return (
    <NewPropertyDialog
      tableClassResource={tableClass}
      selectedCategory={category}
      scope={scope}
      canSave={canSave && canWrite}
      showDialog
      bindShow={show => {
        if (!show) onClose();
      }}
      onCreated={onCreated}
    />
  );
}
