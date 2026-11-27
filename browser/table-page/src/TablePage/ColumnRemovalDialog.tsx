import {
  core,
  useCanWrite,
  useStore,
  useString,
  type Resource,
} from '@tomic/react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { ResourceInline } from '@tomic/resource-ui/views/ResourceInline/index';
import { ResourceUsage } from '@tomic/resource-ui/components/ResourceUsage/index';
import { Button } from '@tomic/ui/components/Button';
import { Checkbox, CheckboxLabel } from '@tomic/ui/components/forms/Checkbox';
import { Column } from '@tomic/ui/components/Row';

interface ColumnRemovalDialogProps {
  tableClass: Resource;
  property: Resource;
  onClose: () => void;
}

export function ColumnRemovalDialog({
  tableClass,
  property,
  onClose,
}: ColumnRemovalDialogProps) {
  const store = useStore();
  const [parent] = useString(property, core.properties.parent);
  const canRemove = useCanWrite(tableClass);
  const canWriteProperty = useCanWrite(property);
  const canDelete = parent === tableClass.subject && canWriteProperty;
  const titleId = useId();
  const [dialogProps, show, close] = useDialog({
    onCancel: onClose,
    onSuccess: onClose,
  });
  const [deleteDefinition, setDeleteDefinition] = useState(false);
  const [detached, setDetached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);

  useEffect(() => {
    show();
  }, [show]);

  const confirm = async () => {
    if (pending.current || !canRemove || (deleteDefinition && !canDelete)) {
      return;
    }

    const agent = store.getAgent();
    pending.current = true;
    setBusy(true);
    setError(undefined);

    try {
      if (!detached) {
        for (const field of [
          core.properties.recommends,
          core.properties.requires,
        ]) {
          const columns = tableClass.getSubjects(field);

          if (columns.includes(property.subject)) {
            await tableClass.set(
              field,
              columns.filter(subject => subject !== property.subject),
            );
          }
        }

        const result = await tableClass.save();

        if (result === 'noop' && tableClass.commitError) {
          throw tableClass.commitError;
        }

        if (result === 'queued' || (deleteDefinition && result === 'offline')) {
          setError('Wait for the column removal to sync before continuing.');

          return;
        }

        setDetached(true);
      }

      if (deleteDefinition) {
        if (
          property.get(core.properties.parent) !== tableClass.subject ||
          store.getAgent()?.subject !== agent?.subject
        ) {
          setError('This property is no longer available for deletion.');

          return;
        }

        await property.destroy(agent);
      }

      close(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const cancel = () => {
    if (!pending.current) {
      close();
    }
  };

  return (
    <Dialog
      {...dialogProps}
      labelledBy={titleId}
      aria-busy={busy}
      disableLightDismiss={busy}
      onClose={cancel}
    >
      <DialogTitle>
        <h1 id={titleId}>
          {deleteDefinition ? 'Delete property' : 'Remove column'}
        </h1>
      </DialogTitle>
      <DialogContent>
        <Column>
          <p>
            Remove <ResourceInline subject={property.subject} /> from{' '}
            <ResourceInline subject={tableClass.subject} />
          </p>
          <ResourceUsage resource={property} />
          <CheckboxLabel>
            <Checkbox
              checked={deleteDefinition}
              disabled={busy || detached || (!canDelete && !deleteDefinition)}
              onChange={setDeleteDefinition}
            />
            Delete property and its children
          </CheckboxLabel>
          {error && <ErrorChip role='alert'>{error}</ErrorChip>}
        </Column>
      </DialogContent>
      <DialogActions>
        <Button subtle disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button
          alert
          disabled={busy || !canRemove || (deleteDefinition && !canDelete)}
          onClick={confirm}
        >
          {deleteDefinition ? 'Delete' : 'Remove'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
