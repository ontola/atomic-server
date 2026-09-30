import { useEffect, useId, useRef, useState } from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { SimpleErrorBlock } from '@components/ErrorLook';
import { LoaderInline } from '@components/Loader';
import { toRelativeDateTime } from '@helpers/dates/relativeDate';
import type { ProxyConnection } from '@helpers/proxyConnections';

interface ConnectDialogProps {
  /** The app's name, as the person knows it. */
  app: string;
  /** The platform's name, such as "Google Calendar". */
  platform: string;
  /** The host of the integration proxy, where the next page is. */
  proxySite: string;
  /** Connections the person already has for this platform; `undefined` while still looking. */
  existing?: ProxyConnection[];
  /** Sends the tab to the proxy. Rejects with what to tell the person. */
  onConnect: () => Promise<void>;
  /** Lets the app use a connection the person already has. */
  onUseExisting: (connection: ProxyConnection) => Promise<void>;
  /** Told once, after the dialog has closed: the connection the app got, if any. */
  onClosed: (used: ProxyConnection | undefined) => void;
}

/** Marks the "connect a new account" button as the one being waited on. */
const NEW_ACCOUNT = 'new';

/**
 * An app asking to use one of the person's accounts elsewhere.
 *
 * Drawn by this page rather than the app's frame, so only a click the person
 * makes here can send the tab away or hand a connection to the app. It says
 * three things: which app, which account, and what happens next. The proxy
 * is named as the site the next page is on, because that is the address the
 * person should expect to see there.
 *
 * A failure stays in the dialog, where the person can try again. The app only
 * hears the end: the connection it got, or that the person closed the dialog.
 */
export function ConnectDialog({
  app,
  platform,
  proxySite,
  existing,
  onConnect,
  onUseExisting,
  onClosed,
}: ConnectDialogProps): React.JSX.Element {
  const titleId = useId();
  // Read once the dialog has closed, which is when the app is told.
  const used = useRef<ProxyConnection | undefined>(undefined);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [dialogProps, show, close] = useDialog({
    onSuccess: () => onClosed(used.current),
    onCancel: () => onClosed(undefined),
  });

  useEffect(() => {
    show();
  }, [show]);

  const connect = () => {
    setBusy(NEW_ACCOUNT);
    setError(undefined);
    // On success the tab is on its way to the proxy, so it stays busy.
    onConnect().catch((e: Error) => {
      setBusy(undefined);
      setError(e.message);
    });
  };

  const pick = (connection: ProxyConnection) => {
    setBusy(connection.connection_id);
    setError(undefined);
    onUseExisting(connection)
      .then(() => {
        used.current = connection;
        close(true);
      })
      .catch((e: Error) => {
        setBusy(undefined);
        setError(e.message);
      });
  };

  const hasExisting = !!existing?.length;
  const connectLabel = hasExisting ? 'Connect another account' : 'Connect';

  return (
    <Dialog {...dialogProps} labelledBy={titleId} width='34rem'>
      <DialogTitle>
        <h1 id={titleId}>Connect {platform}</h1>
      </DialogTitle>
      <DialogContent>
        <Lead>
          <strong>{app}</strong> wants to use your {platform} account.
        </Lead>
        {existing === undefined && (
          <Hint aria-hidden>
            <LoaderInline />
          </Hint>
        )}
        {existing?.length === 0 && (
          <>
            <Hint>You approve this on the next page, at {proxySite}.</Hint>
            <Hint>{app} never sees your password.</Hint>
          </>
        )}
        {hasExisting && (
          <>
            <Hint>
              Use an account you already connected, or connect another one.
            </Hint>
            <Accounts>
              {existing!.map(connection => (
                <Account key={connection.connection_id}>
                  <AccountText>
                    <strong>{platform} account</strong>
                    <AccountDetails connection={connection} />
                  </AccountText>
                  <Button
                    onClick={() => pick(connection)}
                    disabled={busy !== undefined}
                    loading={
                      busy === connection.connection_id
                        ? 'Use this account'
                        : undefined
                    }
                  >
                    Use this account
                  </Button>
                </Account>
              ))}
            </Accounts>
          </>
        )}
        {error && <SimpleErrorBlock role='alert'>{error}</SimpleErrorBlock>}
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => close(false)}>
          Cancel
        </Button>
        <Button
          subtle={hasExisting}
          onClick={connect}
          disabled={busy !== undefined}
          loading={busy === NEW_ACCOUNT ? connectLabel : undefined}
        >
          {connectLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** When it was connected, and which apps use it: all the proxy tells us. */
function AccountDetails({
  connection,
}: {
  connection: ProxyConnection;
}): React.JSX.Element {
  const connected = toDate(connection.created_at);
  const apps = [
    ...new Set(
      connection.delegations
        .map(delegation => delegation.label)
        .filter((label): label is string => !!label),
    ),
  ].join(', ');

  return (
    <>
      {connected && <ConnectedOn date={connected} />}
      {apps && <UsedBy apps={apps} />}
    </>
  );
}

// Each sentence is the root of its own component: text in an element placed
// straight inside `{cond && …}` loses its placeholder in the catalogs.
function ConnectedOn({ date }: { date: Date }): React.JSX.Element {
  const when = toRelativeDateTime(date, false);

  return <Detail>Connected {when}.</Detail>;
}

function UsedBy({ apps }: { apps: string }): React.JSX.Element {
  return <Detail>Used by {apps}.</Detail>;
}

/** The proxy sends RFC 3339 strings; a bare number is Unix seconds or ms. */
function toDate(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date = new Date(
    typeof value === 'number' && value < 1e12 ? value * 1000 : value,
  );

  return Number.isNaN(date.getTime()) ? undefined : date;
}

const Lead = styled.p`
  margin-top: 0;
`;

const Hint = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  margin-bottom: ${p => p.theme.size(1)};
`;

const Detail = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
`;

const Accounts = styled.ul`
  list-style: none;
  margin: 0 0 ${p => p.theme.size()};
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};
`;

/** Wraps below its text on a narrow screen instead of squeezing it. */
const Account = styled.li`
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: ${p => p.theme.size(2)};
  padding: ${p => p.theme.size(1)} ${p => p.theme.size(2)};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const AccountText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  overflow-wrap: anywhere;
`;
