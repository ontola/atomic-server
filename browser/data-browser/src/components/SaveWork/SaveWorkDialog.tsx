import { useEffect, useRef, useState, type JSX } from 'react';
import { useLocation } from '@tanstack/react-router';
import { toast } from 'react-hot-toast';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../Dialog';
import { Button } from '../Button';
import { Column } from '../Row';
import {
  AccountSignInPanel,
  AccountSignInViaBrowser,
} from '../../views/getting-started/AccountSignInPanel';
import { readManagedAccountBinding } from '../../helpers/managed/binding';
import { canHoldProviderCookie } from '../../helpers/managed/deviceLink';
import { noteManagedSessionChanged } from '../../helpers/managed/session';
import { useIsLinkedToAccount } from '../../hooks/useIsLinkedToAccount';
import { getAccountServiceUrl } from '../../helpers/managed/cloudSync';
import { useConnectDeviceProps } from '../../hooks/useConnectDeviceProps';
import { ConnectDevice } from '../ConnectDevice';
import { subscribeSaveWorkDialog } from './saveWorkDialogState';

/** How long to wait for the account to adopt this identity after sign-in. */
export const SAVE_ADOPT_TIMEOUT_MS = 20_000;

function Disclosure({ portalUrl }: { portalUrl: string }): JSX.Element {
  const host = new URL(portalUrl).host;

  return (
    <small data-testid='save-work-disclosure'>
      Your email and an encrypted backup of your identity go to {host}.
    </small>
  );
}

export function SaveWorkContent({
  portalUrl,
  onDone,
}: {
  portalUrl: string | null;
  onDone: () => void;
}): JSX.Element {
  const connectDeviceProps = useConnectDeviceProps();
  const linked = useIsLinkedToAccount();
  const [signedIn, setSignedIn] = useState(false);
  // Bumped by Try again; each value is one wait for the account to adopt us.
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  // Pairing a device links this identity too, so close once that happens
  // while the dialog is open (not if it already was).
  const linkedOnOpen = useRef(linked);

  useEffect(() => {
    if (signedIn || linked === linkedOnOpen.current) return;

    if (linked) onDone();
  }, [signedIn, linked, onDone]);

  useEffect(() => {
    if (!signedIn || !linked) return;

    const email = readManagedAccountBinding()?.owner_email ?? 'your account';

    toast.success(`Saved as ${email}`);
    onDone();
  }, [signedIn, linked, onDone]);

  // Never wait silently: adoption runs in the identity gate against the
  // account server, so say so when it does not finish.
  useEffect(() => {
    if (!signedIn || linked) return;

    setTimedOut(false);
    const timer = window.setTimeout(
      () => setTimedOut(true),
      SAVE_ADOPT_TIMEOUT_MS,
    );

    return () => window.clearTimeout(timer);
  }, [signedIn, linked, attempt]);

  return (
    <Column gap='1rem'>
      <p>
        Only this browser can open your work. Sign in or register with your
        email, or connect another device, so you can open it elsewhere and
        don&apos;t lose access.
      </p>
      {portalUrl &&
        (signedIn && timedOut ? (
          <Column gap='0.75rem'>
            <p role='alert' data-testid='save-work-failed'>
              You are signed in, but saving your work to your account did not
              finish. Check your connection and try again.
            </p>
            <Button
              data-testid='save-work-retry'
              onClick={() => {
                setTimedOut(false);
                setAttempt(n => n + 1);
                // Runs the identity check again.
                noteManagedSessionChanged();
              }}
            >
              Try again
            </Button>
          </Column>
        ) : signedIn ? (
          <p role='status' data-testid='save-work-linking'>
            Saving your work to your account…
          </p>
        ) : canHoldProviderCookie(portalUrl) ? (
          <AccountSignInPanel
            portalUrl={portalUrl}
            onSignedIn={() => setSignedIn(true)}
          />
        ) : (
          <>
            <AccountSignInViaBrowser
              portalUrl={portalUrl}
              onSignedIn={() => setSignedIn(true)}
            />
            <Disclosure portalUrl={portalUrl} />
          </>
        ))}
      {!signedIn && <ConnectDevice {...connectDeviceProps} compact />}
    </Column>
  );
}

/** Shows the Save dialog when something calls `openSaveWorkDialog()`. */
export function SaveWorkDialogHost(): JSX.Element {
  const portalUrl = getAccountServiceUrl();
  const { pathname } = useLocation();
  const [dialogProps, show, close, visible] = useDialog();
  const [openedOn, setOpenedOn] = useState<string>();

  useEffect(
    () =>
      subscribeSaveWorkDialog(() => {
        setOpenedOn(pathname);
        show();
      }),
    [show, pathname],
  );

  // Signing in can send the page elsewhere (the identity gate's hand-over).
  useEffect(() => {
    if (openedOn !== undefined && pathname !== openedOn) {
      setOpenedOn(undefined);
      close();
    }
  }, [pathname, openedOn, close]);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>
          {getAccountServiceUrl() ? 'Register with email' : 'Connect a device'}
        </h1>
      </DialogTitle>
      <DialogContent>
        {/* Only while open: the closed dialog stays in the DOM, and a hidden
            second Connect a device form would share the Sync page's ids. */}
        {visible && (
          <SaveWorkContent portalUrl={portalUrl} onDone={() => close(true)} />
        )}
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => close()}>
          Not now
        </Button>
      </DialogActions>
    </Dialog>
  );
}
