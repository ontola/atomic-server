import { useEffect, useState, type JSX } from 'react';
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
import { useKnownPortalUrl } from '../../hooks/useKnownPortalUrl';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { paths } from '../../routes/paths';
import { subscribeSaveWorkDialog } from './saveWorkDialogState';

/**
 * What the dialog offers, by where this install can save to:
 * - with a portal, the same sign-in options as every other screen. Signing up
 *   and signing in are the same buttons; the identity gate then adopts this
 *   device's key as the account's, or hands over when the account has one.
 * - without one (self-hosted), nothing here depends on an account: the way to
 *   keep and reach the work elsewhere is another device.
 */
/** How long to wait for the account to adopt this identity after sign-in. */
export const SAVE_ADOPT_TIMEOUT_MS = 20_000;

export function SaveWorkContent({
  portalUrl,
  onDone,
}: {
  portalUrl: string | null;
  onDone: () => void;
}): JSX.Element {
  const navigate = useNavigateWithTransition();
  const linked = useIsLinkedToAccount();
  const [signedIn, setSignedIn] = useState(false);
  // Bumped by Try again; each value is one wait for the account to adopt us.
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

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

  if (!portalUrl) {
    return (
      <Column gap='1rem'>
        <p>
          Your work is saved on this device. To open it on other devices and not
          lose it, connect another device.
        </p>
        <Button
          data-testid='save-work-connect'
          onClick={() => {
            onDone();
            navigate(paths.sync);
          }}
        >
          Connect a device
        </Button>
      </Column>
    );
  }

  return (
    <Column gap='1rem'>
      <p>
        Your work is saved on this device. Add your email so you can open it on
        other devices and don&apos;t lose it.
      </p>
      {signedIn && timedOut ? (
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
        <AccountSignInViaBrowser
          portalUrl={portalUrl}
          onSignedIn={() => setSignedIn(true)}
        />
      )}
    </Column>
  );
}

/** Shows the Save dialog when something calls `openSaveWorkDialog()`. */
export function SaveWorkDialogHost(): JSX.Element {
  const portalUrl = useKnownPortalUrl();
  const { pathname } = useLocation();
  const [dialogProps, show, close] = useDialog();
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
        <h1>{portalUrl ? 'Register with email' : 'Connect a device'}</h1>
      </DialogTitle>
      <DialogContent>
        <SaveWorkContent portalUrl={portalUrl} onDone={() => close(true)} />
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => close()}>
          Not now
        </Button>
      </DialogActions>
    </Dialog>
  );
}
