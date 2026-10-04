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

/** What went wrong, and which button it came from. */
interface Failure {
  during: 'connect' | 'pick';
  detail: string;
}

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
  const [failure, setFailure] = useState<Failure>();
  const [dialogProps, show, close] = useDialog({
    onSuccess: () => onClosed(used.current),
    onCancel: () => onClosed(undefined),
  });

  useEffect(() => {
    show();
  }, [show]);

  const connect = () => {
    setBusy(NEW_ACCOUNT);
    setFailure(undefined);
    // On success the tab is on its way to the proxy, so it stays busy.
    onConnect().catch((e: Error) => {
      setBusy(undefined);
      setFailure({ during: 'connect', detail: e.message });
    });
  };

  const pick = (connection: ProxyConnection) => {
    setBusy(connection.connection_id);
    setFailure(undefined);
    onUseExisting(connection)
      .then(() => {
        used.current = connection;
        close(true);
      })
      .catch((e: Error) => {
        setBusy(undefined);
        setFailure({ during: 'pick', detail: e.message });
      });
  };

  const hasExisting = !!existing?.length;
  const connectLabel = hasExisting ? 'Use another account' : 'Connect';

  return (
    <Dialog {...dialogProps} labelledBy={titleId} width='34rem'>
      <DialogTitle>
        <h1 id={titleId}>Connect {platform}</h1>
      </DialogTitle>
      <DialogContent>
        <Lead>
          <strong>{app}</strong> wants to use your {platform} account.
        </Lead>
        {existing === undefined && <Looking aria-hidden />}
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
        {failure && (
          <Failed role='alert'>
            {failure.during === 'pick' ? (
              <strong>Could not use this account.</strong>
            ) : (
              <strong>Could not start connecting.</strong>
            )}
            <span>{failure.detail}</span>
          </Failed>
        )}
      </DialogContent>
      <Actions>
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
      </Actions>
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

/** A line of text still coming: where the hint or the accounts will be. */
const Looking = styled(LoaderInline)`
  display: block;
  flex: none;
  width: min(20rem, 70%);
  height: 1.1em;
  margin-bottom: ${p => p.theme.size()};
`;

/** Proxy errors name request paths, which must wrap rather than overflow. */
const Failed = styled(SimpleErrorBlock)`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: ${p => p.theme.size(1)};
  padding: ${p => p.theme.size(1)} ${p => p.theme.size(2)};
  overflow-wrap: anywhere;

  span {
    font-size: 0.9rem;
  }
`;

/**
 * Buttons keep their words whole: on a narrow screen they go onto a second
 * line instead of squeezing ("Cance" / "l").
 */
const Actions = styled(DialogActions)`
  flex-wrap: wrap;

  & > button {
    white-space: nowrap;
  }
`;

const Accounts = styled.ul`
  list-style: none;
  margin: 0;
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
