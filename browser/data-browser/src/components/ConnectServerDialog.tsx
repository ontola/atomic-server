import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaCheck } from 'react-icons/fa6';
import { Dialog, DialogContent, DialogTitle, useDialog } from './Dialog';
import { Button } from './Button';

interface ConnectServerDialogProps {
  /** Servers this browser already knows about; the active one is checked. */
  knownServers: string[];
  activeServer: string;
  /** True in Tauri, where `localhost` is this device's embedded server. */
  isNode: boolean;
  setServer: (url: string) => void;
  show: boolean;
  bindShow: (show: boolean) => void;
}

/**
 * Connecting a server is the same kind of act as pairing a device — pick a
 * place your data lives. Pairing is shown outright on the Sync page (its code
 * is routing-only); a server URL needs typing, so it gets a dialog.
 */
export function ConnectServerDialog({
  knownServers,
  activeServer,
  isNode,
  setServer,
  show,
  bindShow,
}: ConnectServerDialogProps): JSX.Element {
  const [dialogProps, showDialog] = useDialog({ bindShow });
  const [serverInput, setServerInput] = useState('');

  useEffect(() => {
    if (show) {
      setServerInput('');
      showDialog();
    }
  }, [show]);

  if (!show) {
    return <></>;
  }

  const connect = () => {
    const url = serverInput.trim();

    if (!url) {
      return;
    }

    setServer(url);
    bindShow(false);
  };

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Connect a device</h1>
      </DialogTitle>
      <DialogContent>
        <Explainer>
          A server keeps your workspaces online and backed up, and lets you
          share them with other people.
        </Explainer>

        {knownServers.length > 1 && (
          <>
            <h2>Switch to</h2>
            <SwitchList>
              {knownServers.map(server => {
                const { hostname } = new URL(server);
                const active = server === activeServer;
                const label =
                  isNode &&
                  (hostname === 'localhost' || hostname === '127.0.0.1')
                    ? 'Embedded (this device)'
                    : hostname;

                return (
                  <SwitchItem
                    key={server}
                    type='button'
                    $active={active}
                    onClick={() => {
                      setServer(server);
                      bindShow(false);
                    }}
                  >
                    {label}
                    {active && <FaCheck aria-hidden />}
                  </SwitchItem>
                );
              })}
            </SwitchList>
          </>
        )}

        {/* Only worth a heading when it distinguishes from the list above. */}
        {knownServers.length > 1 && <h2>Add a server</h2>}
        <AddServerRow
          onSubmit={e => {
            e.preventDefault();
            connect();
          }}
        >
          <ServerInput
            autoFocus
            autoComplete='off'
            placeholder='https://your-server.example'
            value={serverInput}
            onChange={e => setServerInput(e.target.value)}
          />
          <Button type='submit' subtle disabled={!serverInput.trim()}>
            Connect
          </Button>
        </AddServerRow>
        <DocsLink
          href='https://docs.atomicdata.dev/atomicserver/installation.html'
          target='_blank'
          rel='noopener'
        >
          How to run your own server
        </DocsLink>
      </DialogContent>
    </Dialog>
  );
}

const Explainer = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;

const SwitchList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.4rem;
`;

const SwitchItem = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  border: none;
  cursor: pointer;
  border-radius: ${p => p.theme.radius};
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  color: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.text)};
  font-weight: ${p => (p.$active ? 600 : 400)};
  background: ${p => (p.$active ? `${p.theme.colors.main}14` : 'transparent')};

  &:hover {
    background: ${p => p.theme.colors.bg2};
  }

  svg {
    font-size: 0.7rem;
    flex-shrink: 0;
  }
`;

const AddServerRow = styled.form`
  display: flex;
  gap: 0.5rem;
  align-items: center;
`;

const ServerInput = styled.input`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  flex: 1;
  min-width: 0;
`;

const DocsLink = styled.a`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  margin-top: 0.6rem;
  display: inline-block;
`;
