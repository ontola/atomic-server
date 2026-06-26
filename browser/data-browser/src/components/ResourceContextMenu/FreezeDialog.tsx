import { useEffect, useState } from 'react';
import { useResource, useStore } from '@tomic/react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../Dialog';
import { Button } from '../Button';

interface FreezeDialogProps {
  subject: string;
  show: boolean;
  bindShow: (open: boolean) => void;
}

type FreezeMode = 'json-ad' | 'loro';

/**
 * Freezes a resource (and, by default, the structure it references) into
 * immutable, content-addressed `did:ad:frozen` JSON-AD. Shows the result with
 * copy / download, and can publish it to the server's `/frozen` store.
 */
export function FreezeDialog({
  subject,
  show: open,
  bindShow,
}: FreezeDialogProps): React.JSX.Element {
  const store = useStore();
  const resource = useResource(subject);
  const [dialogProps, show, hide, isOpen] = useDialog({ bindShow });

  const [mode, setMode] = useState<FreezeMode>('json-ad');
  const [closure, setClosure] = useState(true);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (open) {
      show();
    } else {
      hide();
    }
  }, [open]);

  useEffect(() => {
    if (!isOpen || mode !== 'json-ad') {
      return;
    }

    let active = true;
    setError(undefined);

    store
      .freezeStructure(subject, { closure })
      .then(result => {
        if (active) {
          setJson(JSON.stringify(result.frozen, null, 2));
        }
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
        }
      });

    return () => {
      active = false;
    };
  }, [isOpen, subject, closure, mode, store]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(json);
    toast.success('Copied frozen JSON-AD');
  };

  const handleDownload = () => {
    const blob = new Blob([json], { type: 'application/ad+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${resource.title || 'resource'}.frozen.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePublish = async () => {
    setPublishing(true);

    try {
      const result = await store.freezeStructure(subject, {
        closure,
        save: true,
      });
      const count = Object.keys(result.frozen).length;
      toast.success(`Published ${count} frozen resource${count === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(`Publish failed: ${(e as Error).message}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog {...dialogProps} width='85ch'>
      {isOpen && (
        <>
          <DialogTitle>
            <h1>Freeze {resource.title}</h1>
          </DialogTitle>
          <StyledContent>
            <Controls>
              <ModeGroup role='radiogroup' aria-label='Freeze format'>
                <ModeOption>
                  <input
                    type='radio'
                    name='freeze-mode'
                    checked={mode === 'json-ad'}
                    onChange={() => setMode('json-ad')}
                  />
                  JSON-AD <Hint>reproducible, no history</Hint>
                </ModeOption>
                <ModeOption
                  title='Coming soon — keeps CRDT history, binary, id not reproducible'
                  $disabled
                >
                  <input type='radio' name='freeze-mode' disabled />
                  Loro <Hint>coming soon</Hint>
                </ModeOption>
              </ModeGroup>
              <ModeOption>
                <input
                  type='checkbox'
                  checked={closure}
                  onChange={e => setClosure(e.target.checked)}
                />
                Include referenced structure
              </ModeOption>
            </Controls>
            {error ? <ErrorText>{error}</ErrorText> : <Pre>{json}</Pre>}
          </StyledContent>
          <DialogActions>
            <Button subtle onClick={handleCopy} disabled={!json}>
              Copy
            </Button>
            <Button subtle onClick={handleDownload} disabled={!json}>
              Download
            </Button>
            <Button onClick={handlePublish} disabled={!json || publishing}>
              Publish to server
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

const StyledContent = styled(DialogContent)`
  max-height: 90vh;
  overflow-x: hidden;
`;

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 2rem;
  align-items: center;
  margin-bottom: 1rem;
`;

const ModeGroup = styled.div`
  display: flex;
  gap: 1.5rem;
`;

const ModeOption = styled.label<{ $disabled?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: ${p => (p.$disabled ? 'not-allowed' : 'pointer')};
  opacity: ${p => (p.$disabled ? 0.5 : 1)};
`;

const Hint = styled.small`
  color: ${p => p.theme.colors.textLight};
`;

const Pre = styled.pre`
  background: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 1rem;
  overflow: auto;
  max-height: 60vh;
  font-size: 0.8rem;
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
`;
