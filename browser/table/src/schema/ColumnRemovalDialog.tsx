import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { tableTheme } from '../theme.js';
import { createTableDraftCommit } from './draftCommit.js';

export interface TableColumnRemovalDialogProps {
  /** Captured owner/property identity. A different scope starts a new intent. */
  scope: string;
  canRemove: boolean;
  canDeleteDefinition: boolean;
  children?: ReactNode;
  onConfirm: (deleteDefinition: boolean) => Promise<void>;
  onClose: () => void;
  messages?: Partial<{
    removeTitle: string;
    deleteTitle: string;
    deleteDefinition: string;
    remove: string;
    delete: string;
    cancel: string;
    pending: string;
    unavailable: string;
  }>;
}

/** Mount at page level, outside headers that schema changes can unmount.
 * Backend services own authorization, captured identity and write confirmation.
 * A failed write retains the intent; closing never cancels an in-flight write. */
export function TableColumnRemovalDialog(props: TableColumnRemovalDialogProps) {
  return <RemovalIntent key={props.scope} {...props} />;
}

function RemovalIntent({
  scope,
  canRemove,
  canDeleteDefinition,
  children,
  onConfirm,
  onClose,
  messages,
}: TableColumnRemovalDialogProps) {
  const controller = useMemo(() => createTableDraftCommit(scope), [scope]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [deleteDefinition, setDeleteDefinition] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const text = {
    removeTitle: 'Remove column',
    deleteTitle: 'Delete property',
    deleteDefinition: 'Delete property and its children',
    remove: 'Remove',
    delete: 'Delete',
    cancel: 'Cancel',
    pending: 'Removing column…',
    unavailable:
      'Column removal is unavailable. Check access and the selected table.',
    ...messages,
  };
  const valid = canRemove && (!deleteDefinition || canDeleteDefinition);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();

    return () => {
      controller.invalidate();
      element?.close();
    };
  }, [controller]);

  const cancel = () => {
    if (!controller.getSnapshot().busy) onClose();
  };

  const confirm = async () => {
    const result = await controller.run(
      () => onConfirm(deleteDefinition),
      valid,
    );

    if (result.status === 'saved') onClose();
  };

  return (
    <RemovalDialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-busy={state.busy}
      onCancel={event => {
        event.preventDefault();
        cancel();
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <h2 id={titleId}>
        {deleteDefinition ? text.deleteTitle : text.removeTitle}
      </h2>
      {children}
      <label style={{ display: 'flex', gap: '0.5rem', marginBlock: '1rem' }}>
        <input
          type='checkbox'
          checked={deleteDefinition}
          disabled={state.busy || (!canDeleteDefinition && !deleteDefinition)}
          onChange={event => {
            if (controller.getSnapshot().busy) return;
            if (event.target.checked && !canDeleteDefinition) return;
            setDeleteDefinition(event.target.checked);
            controller.clearError();
          }}
        />
        {text.deleteDefinition}
      </label>
      {!valid && <p role='alert'>{text.unavailable}</p>}
      {state.error && <p role='alert'>{state.error.message}</p>}
      {state.busy && <p role='status'>{text.pending}</p>}
      <footer
        style={{ display: 'flex', justifyContent: 'end', gap: '0.75rem' }}
      >
        <button disabled={state.busy} onClick={cancel}>
          {text.cancel}
        </button>
        <button disabled={state.busy || !valid} onClick={() => void confirm()}>
          {deleteDefinition ? text.delete : text.remove}
        </button>
      </footer>
    </RemovalDialog>
  );
}

const RemovalDialog = styled.dialog`
  max-width: min(36rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  overflow: auto;
  box-sizing: border-box;
  padding: 1.5rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
  font:
    1rem/1.5 system-ui,
    sans-serif;
  box-shadow: ${p => tableTheme(p.theme).boxShadowIntense};
  &::backdrop {
    background: #0005;
  }
  h2 {
    margin-top: 0;
    font-size: 1.25rem;
  }
  footer button {
    min-height: 2.25rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
    border-radius: ${p => tableTheme(p.theme).radius};
    background: ${p => tableTheme(p.theme).colors.bg1};
    color: inherit;
    font: inherit;
    cursor: pointer;
    &:disabled {
      opacity: 0.55;
      cursor: default;
    }
  }
`;
