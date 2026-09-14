import { useEffect, useState } from 'react';
import { useResourceSnapshot, useStore } from '@tomic/react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { CodeBlock } from '@components/CodeBlock';
import { ErrorBlock } from '@components/ErrorLook';
import { styled } from 'styled-components';
import {
  captureDocumentSourceSnapshot,
  type DocumentSourceSnapshot,
} from './documentSourceSnapshot';

interface DocumentSourceDialogProps {
  subject: string;
  show: boolean;
  bindShow: (open: boolean) => void;
}

/** A read-only, point-in-time TipTap JSON inspector for Document V2. */
export function DocumentSourceDialog({
  subject,
  show: open,
  bindShow,
}: DocumentSourceDialogProps): React.JSX.Element {
  // The Resource handle itself is stable while it hydrates. Render-time
  // readiness and errors must use this immutable subscription snapshot.
  const { resource, loading, error } = useResourceSnapshot(subject);
  const store = useStore();
  const [dialogProps, show, hide, isOpen] = useDialog({ bindShow });
  const [snapshot, setSnapshot] = useState<DocumentSourceSnapshot>();

  useEffect(() => {
    if (open) {
      show();
    } else {
      hide();
    }
  }, [hide, open, show]);

  // Capture only once per opening. This is deliberately a snapshot: it does
  // not subscribe an editor or apply any Loro changes while the dialog is up.
  useEffect(() => {
    if (!isOpen) {
      setSnapshot(undefined);

      return;
    }

    if (snapshot !== undefined) {
      return;
    }

    const captured = captureDocumentSourceSnapshot(
      resource,
      store,
      loading,
      error,
    );

    if (captured !== undefined) {
      setSnapshot(captured);
    }
  }, [error, isOpen, loading, resource, snapshot, store]);

  return (
    <Dialog {...dialogProps} width='85ch'>
      {isOpen && (
        <>
          <DialogTitle>
            <h1>Document source</h1>
          </DialogTitle>
          <StyledDialogContent>
            <p>
              This is a read-only JSON snapshot captured when you opened this
              dialog. It does not update while the dialog is open.
            </p>
            {loading || snapshot === undefined ? (
              <p>Loading document source…</p>
            ) : snapshot.kind === 'source' ? (
              <CodeBlock content={snapshot.content} />
            ) : snapshot.kind === 'unavailable' ? (
              <p>{snapshot.message}</p>
            ) : (
              <ErrorBlock error={snapshot.error} />
            )}
          </StyledDialogContent>
        </>
      )}
    </Dialog>
  );
}

const StyledDialogContent = styled(DialogContent)`
  max-height: 80vh;
  overflow: auto;
`;
