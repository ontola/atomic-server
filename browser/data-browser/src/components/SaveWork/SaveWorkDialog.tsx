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

  useEffect(() => {
    if (!signedIn || !linked) return;

    const email = readManagedAccountBinding()?.owner_email ?? 'your account';

    toast.success(`Saved as ${email}`);
    onDone();
  }, [signedIn, linked, onDone]);

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
      {signedIn ? (
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
        <h1>Keep your work</h1>
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
