import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
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
import { Column, Row } from '../Row';
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
import {
  forgetManagedPortalUrl,
  rememberManagedPortalUrl,
  safePortalUrl,
} from '../../helpers/managed/api';
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

/**
 * The account portal offered to an install that knows none. Build-time
 * overridable so local testing can point at a local portal.
 */
export function defaultAccountPortal(): string | null {
  const fromEnv = import.meta.env?.VITE_DEFAULT_ACCOUNT_PORTAL as
    | string
    | undefined;

  return safePortalUrl(fromEnv || ATOMIC_PLACE_WEBSITE) ?? null;
}

export function SaveWorkContent({
  portalUrl,
  onDone,
  onChoosePortal,
  onBack,
}: {
  portalUrl: string | null;
  onDone: () => void;
  /** Offer signing in with the default account portal (no portal known). */
  onChoosePortal?: () => void;
  /** Set when the portal was chosen here: returns to device pairing. */
  onBack?: () => void;
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
          Only this browser can open your work. Connect another device or sign
          in, so you can open it elsewhere and don&apos;t lose access.
        </p>
        <ConnectDevice {...connectDeviceProps} hideTitle />
        {onChoosePortal && (
          <Row gap='0.25rem' center wrapItems>
            <span>No second device?</span>
            <Button
              subtle
              data-testid='save-work-choose-portal'
              onClick={onChoosePortal}
            >
              Sign in with atomic.place
            </Button>
          </Row>
        )}
      </Column>
    );
  }

  return (
    <Column gap='1rem'>
      <p>
        Only this browser can open your work. Sign in or register with your
        email, so you can open it elsewhere and don&apos;t lose access.
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
      {onBack && !signedIn && (
        <div>
          <Button subtle data-testid='save-work-back' onClick={onBack}>
            Back
          </Button>
        </div>
      )}
    </Column>
  );
}

/** Shows the Save dialog when something calls `openSaveWorkDialog()`. */
export function SaveWorkDialogHost(): JSX.Element {
  const knownPortal = useKnownPortalUrl();
  // The portal the user picked here, for an install that knows none.
  const [chosenPortal, setChosenPortal] = useState<string | null>(null);
  const portalUrl = knownPortal ?? chosenPortal;
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

  // Choosing is explicit, so it is remembered for the identity gate and the
  // managed API; walking away without an account forgets it again, so the
  // install is not left in portal mode.
  const choosePortal = () => {
    const portal = defaultAccountPortal();

    if (!portal) return;

    rememberManagedPortalUrl(portal);
    setChosenPortal(portal);
  };

  const back = useCallback(() => {
    if (!readManagedAccountBinding()) forgetManagedPortalUrl();

    setChosenPortal(null);
  }, []);

  useEffect(() => {
    if (!visible && chosenPortal) back();
  }, [visible, chosenPortal, back]);

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
        <SaveWorkContent
          portalUrl={portalUrl}
          onDone={() => close(true)}
          onChoosePortal={choosePortal}
          onBack={chosenPortal && !knownPortal ? back : undefined}
        />
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => close()}>
          Not now
        </Button>
      </DialogActions>
    </Dialog>
  );
}
