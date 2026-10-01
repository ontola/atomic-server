import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { SearchBox } from '@components/forms/SearchBox';
import { NewFormDialog } from '@components/forms/NewForm/NewFormDialog';
import type { FormAsk, PickResourceAsk } from './hostUIRequests';

/**
 * A dialog that is open from the moment it mounts, and reports once when it
 * closes. The host mounts one per ask and unmounts it after the answer.
 */
function useOpenDialog(onClosed: () => void) {
  // Stable, so `show` keeps its identity and the dialog opens once.
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  });
  const bindShow = useCallback((open: boolean) => {
    if (!open) onClosedRef.current();
  }, []);
  const [dialogProps, show, close] = useDialog({ bindShow });

  useEffect(() => {
    show();
  }, [show]);

  return [dialogProps, close] as const;
}

/** Search for a resource on the app's behalf. Resolves to its subject. */
export function PickResourceDialog({
  appTitle,
  ask,
  onPicked,
  onClosed,
}: {
  appTitle: string;
  ask: PickResourceAsk;
  onPicked: (subject: string) => void;
  onClosed: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<string>();
  const [dialogProps, close] = useOpenDialog(onClosed);

  return (
    <Dialog {...dialogProps}>
      <Dialog.Title>
        <h1>{ask.title ?? 'Choose a resource'}</h1>
      </Dialog.Title>
      <Dialog.Content>
        <AskedBy>Asked by {appTitle}</AskedBy>
        <Padded>
          <SearchBox
            autoFocus
            value={picked}
            onChange={setPicked}
            isA={ask.isA}
          />
        </Padded>
      </Dialog.Content>
      <Dialog.Actions>
        <Button subtle onClick={() => close(false)}>
          Cancel
        </Button>
        <Button
          disabled={!picked}
          onClick={() => {
            if (!picked) return;
            onPicked(picked);
            close(true);
          }}
        >
          Choose
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}

/**
 * Atomic's own form for a new resource of a class, for an app. Saved by the
 * person, as their own edit, which is why its parent must be under the app:
 * the person sees the fields, not where the resource will go.
 */
export function AppFormDialog({
  ask,
  parent,
  onSaved,
  onClosed,
}: {
  ask: FormAsk;
  parent: string;
  onSaved: (subject: string) => void;
  onClosed: () => void;
}): JSX.Element {
  const [dialogProps, close] = useOpenDialog(onClosed);

  return (
    <Dialog {...dialogProps} width='50rem'>
      {dialogProps.show && (
        <NewFormDialog
          classSubject={ask.classSubject}
          parent={parent}
          initialProps={ask.propVals}
          onSaveClick={subject => {
            onSaved(subject);
            close(true);
          }}
          onCancel={() => close(false)}
        />
      )}
    </Dialog>
  );
}

export const AskedBy = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  margin-top: 0;
`;

const Padded = styled.div`
  padding: 2px;
`;
