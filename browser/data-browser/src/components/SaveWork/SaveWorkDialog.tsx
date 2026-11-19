import { useEffect, useRef, useState, type JSX } from 'react';
import { useLocation } from '@tanstack/react-router';
import { styled } from 'styled-components';
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
import { useConnectDeviceProps } from '../../hooks/useConnectDeviceProps';
import { ConnectDevice } from '../ConnectDevice';
import { ATOMIC_PLACE_WEBSITE } from '../Logo';
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
  const connectDeviceProps = useConnectDeviceProps();
  const linked = useIsLinkedToAccount();
  const [signedIn, setSignedIn] = useState(false);
  // Bumped by Try again; each value is one wait for the account to adopt us.
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  // Without a portal, pairing a device is what links this identity, so close
  // once that happens while the dialog is open (not if it already was).
  const linkedOnOpen = useRef(linked);

  useEffect(() => {
    if (portalUrl || linked === linkedOnOpen.current) return;

    if (linked) onDone();
  }, [portalUrl, linked, onDone]);

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
          Your work is saved on this device. Connect another device to open it
          elsewhere and not lose it.
        </p>
        <ConnectDevice {...connectDeviceProps} hideTitle />
        <Muted>
          No second device? An account on{' '}
          <a href={ATOMIC_PLACE_WEBSITE} target='_blank' rel='noopener'>
            atomic.place
          </a>{' '}
          keeps your work too.
        </Muted>
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

const Muted = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.82rem;
`;
