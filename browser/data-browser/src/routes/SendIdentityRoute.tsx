import { useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { Button } from '@tomic/ui/components/Button';
import { Column, Row } from '@tomic/ui/components/Row';
import {
  accountAddress,
  getManagedAccountOrNull,
  type ManagedAccount,
} from '../helpers/managed/session';
import { getAccountServiceUrl } from '../helpers/managed/cloudSync';
import { canHoldProviderCookie } from '../helpers/managed/deviceLink';
import {
  getUnlockableRecoverySecret,
  tryAutoUnlock,
  unlockBackup,
  type RecoverySecret,
  type UnlockMethod,
} from '../helpers/managed/recovery';
import {
  describeLink,
  sendIdentity,
  type LinkDescription,
} from '../helpers/managed/sendIdentity';
import { UnlockBackupForm } from '../components/UnlockBackupForm';
import { fetchManagedInfo } from '../helpers/managedServer';
import { useSettings } from '../helpers/AppSettings';
import { useSignOut } from '../hooks/useSignOut';
import {
  AccountSignInPanel,
  AccountSignInViaBrowser,
} from '../views/getting-started/AccountSignInPanel';
import {
  CardError,
  CardSubtitle,
  CardTitle,
  CtaButton,
  OnboardingCard,
  OnboardingWrap,
  Shell,
} from '../views/getting-started/chrome';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { styled } from 'styled-components';

export const SendIdentityRoute = createRoute({
  path: pathNames.sendIdentity,
  component: () => <SendIdentityPage />,
  getParentRoute: () => appRoute,
  validateSearch: (search): { code: string } => ({
    code: typeof search.code === 'string' ? search.code.trim() : '',
  }),
});

/** The onboarding card centers its text for the welcome screens; a dialog
 * with fields and choices reads better left-aligned, like the rest of the app. */
const LeftAlignedCard = styled(OnboardingCard)`
  & h2,
  & p {
    text-align: left;
  }
`;

type Phase =
  | { name: 'loading' }
  | { name: 'sign-in' }
  | { name: 'confirm'; link: LinkDescription; account: ManagedAccount }
  | {
      name: 'unlock';
      link: LinkDescription;
      recovery: RecoverySecret;
      methods: UnlockMethod[];
    }
  | { name: 'sending' }
  | { name: 'done'; deviceName: string }
  | { name: 'failed'; message: string };

/**
 * /app/send-identity?code=<user code>
 *
 * Where a person lets an app they started on another device (the Atomic mobile
 * app) receive their identity. The app waits with a code and a key it made;
 * this page unlocks the account's backup here and seals the secret to that key,
 * so the provider only relays ciphertext. Nothing is sent without a press.
 */
function SendIdentityPage() {
  const { code } = SendIdentityRoute.useSearch();
  const { baseURL } = useSettings();
  const signOutAndReset = useSignOut();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [portalUrl, setPortalUrl] = useState<string | null>(() =>
    getAccountServiceUrl(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void fetchManagedInfo(baseURL).then(info => {
      if (!cancelled) {
        setPortalUrl(getAccountServiceUrl(info));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  useEffect(() => {
    let cancelled = false;
    const fail = (message: string) =>
      !cancelled && setPhase({ name: 'failed', message });

    if (!code) {
      fail('This link has no code. Start again from your device.');

      return;
    }

    void (async () => {
      const account = await getManagedAccountOrNull();

      if (cancelled) return;

      if (!account) {
        setPhase({ name: 'sign-in' });

        return;
      }

      try {
        const link = await describeLink(code);

        if (!link.appKey) {
          fail('That device did not ask for your identity.');
        } else if (link.alreadyApproved) {
          fail('This code was already used. Ask the device for a new one.');
        } else if (!cancelled) {
          setPhase({ name: 'confirm', link, account });
        }
      } catch (err) {
        fail(
          err instanceof Error ? err.message : 'Could not look up that code.',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, attempt]);

  /**
   * Seal and deposit an unlocked secret. A failed deposit ends the page, since
   * the person cannot fix it from here.
   */
  async function deliver(
    link: LinkDescription,
    recovery: RecoverySecret,
    secret: string,
  ) {
    setPhase({ name: 'sending' });

    try {
      await sendIdentity(code, link, recovery, secret);
      setPhase({ name: 'done', deviceName: link.deviceName });
    } catch (err) {
      setPhase({
        name: 'failed',
        message:
          err instanceof Error ? err.message : 'Could not send your identity.',
      });
    }
  }

  async function unlockStep(
    p: Extract<Phase, { name: 'unlock' }>,
    method: UnlockMethod,
    input?: string,
  ) {
    setBusy(true);
    setError(undefined);

    try {
      await deliver(
        p.link,
        p.recovery,
        await unlockBackup(p.recovery, method, input),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not unlock your backup.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(link: LinkDescription, account: ManagedAccount) {
    setBusy(true);
    setError(undefined);

    try {
      const recovery = await getUnlockableRecoverySecret();

      if (!recovery) {
        setPhase({
          name: 'failed',
          message:
            'This account has no backup yet. Create it in the web app first.',
        });

        return;
      }

      // The account alone, then the passkey on this same press; otherwise ask.
      const outcome = await tryAutoUnlock(recovery, account.email);

      if ('secret' in outcome) {
        await deliver(link, recovery, outcome.secret);
      } else {
        setPhase({ name: 'unlock', link, recovery, methods: outcome.methods });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read your backup.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** One sign-in, so one sign-out: the account and this browser's identity
   * both go, then the page asks for a sign-in again. */
  async function switchAccount() {
    setBusy(true);

    try {
      await signOutAndReset();
      setPhase({ name: 'sign-in' });
    } finally {
      setBusy(false);
    }
  }

  const onSignedIn = () => {
    setPhase({ name: 'loading' });
    setAttempt(n => n + 1);
  };

  return (
    <Shell>
      <OnboardingWrap>
        <LeftAlignedCard>
          <Column gap='1rem'>
            {phase.name === 'loading' || phase.name === 'sending' ? (
              <CardSubtitle>
                {phase.name === 'sending' ? 'Signing in…' : 'Loading…'}
              </CardSubtitle>
            ) : null}

            {phase.name === 'sign-in' ? (
              <>
                <CardTitle>Sign in to continue</CardTitle>
                <CardSubtitle>
                  Sign in to your account to continue on your other device.
                </CardSubtitle>
                {portalUrl && canHoldProviderCookie(portalUrl) ? (
                  <AccountSignInPanel
                    portalUrl={portalUrl}
                    onSignedIn={onSignedIn}
                  />
                ) : portalUrl ? (
                  <AccountSignInViaBrowser
                    portalUrl={portalUrl}
                    onSignedIn={onSignedIn}
                  />
                ) : (
                  <CardError role='alert'>
                    No account service is known here.
                  </CardError>
                )}
              </>
            ) : null}

            {phase.name === 'confirm' ? (
              <>
                <CardTitle>Sign in to {phase.link.deviceName}?</CardTitle>
                <CardSubtitle>
                  {phase.link.deviceName} asks to use your account. Only
                  continue if you started this on your own device just now and
                  it shows code {code}.
                </CardSubtitle>
                <CardSubtitle>
                  Signed in as {accountAddress(phase.account)}.
                </CardSubtitle>
                {error ? <CardError role='alert'>{error}</CardError> : null}
                <Row wrapItems>
                  <CtaButton
                    disabled={busy}
                    onClick={() => void handleSend(phase.link, phase.account)}
                  >
                    {busy
                      ? 'Signing in…'
                      : `Sign in to ${phase.link.deviceName}`}
                  </CtaButton>
                  <Button
                    subtle
                    disabled={busy}
                    onClick={() => void switchAccount()}
                  >
                    Use another account
                  </Button>
                </Row>
              </>
            ) : null}

            {phase.name === 'unlock' ? (
              <>
                <CardTitle>Confirm it’s you</CardTitle>
                <CardSubtitle>
                  Choose how to finish signing in to {phase.link.deviceName}.
                </CardSubtitle>
                <UnlockBackupForm
                  methods={phase.methods}
                  busy={busy}
                  error={error}
                  onUnlock={(method, input) =>
                    void unlockStep(phase, method, input)
                  }
                />
              </>
            ) : null}

            {phase.name === 'done' ? (
              <>
                <CardTitle>Signed in to {phase.deviceName}</CardTitle>
                <CardSubtitle>Go back to {phase.deviceName}.</CardSubtitle>
              </>
            ) : null}

            {phase.name === 'failed' ? (
              <>
                <CardTitle>Could not finish signing in</CardTitle>
                <CardError role='alert'>{phase.message}</CardError>
              </>
            ) : null}
          </Column>
        </LeftAlignedCard>
      </OnboardingWrap>
    </Shell>
  );
}
