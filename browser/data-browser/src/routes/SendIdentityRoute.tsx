import { useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { decodeSecret } from '@tomic/react';
import { Button } from '@tomic/ui/components/Button';
import { Column, Row } from '@tomic/ui/components/Row';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import {
  accountAddress,
  getManagedAccount,
  type ManagedAccount,
} from '../helpers/managed/session';
import { getAccountServiceUrl } from '../helpers/managed/cloudSync';
import { canHoldProviderCookie } from '../helpers/managed/deviceLink';
import { getUnlockableRecoverySecret } from '../helpers/managed/recovery';
import type { RecoverySecret } from '../helpers/managed/recovery';
import {
  describeLink,
  sendIdentity,
  unlockBackup,
  unlockMethods,
  type LinkDescription,
  type UnlockMethod,
} from '../helpers/managed/sendIdentity';
import { fetchManagedInfo } from '../helpers/managedServer';
import { useSettings } from '../helpers/AppSettings';
import { signOutEverywhere } from '../helpers/managed/signOut';
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

function isSecret(value: string): boolean {
  try {
    decodeSecret(value.trim());

    return true;
  } catch {
    return false;
  }
}

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
  const { baseURL, agent, setAgent } = useSettings();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [portalUrl, setPortalUrl] = useState<string | null>(() =>
    getAccountServiceUrl(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [keyInput, setKeyInput] = useState('');

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
      const account = await getManagedAccount().catch(() => null);

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
   * Unlock, then seal and deposit. False when the unlock failed (the caller
   * decides whether to say so); a failed deposit ends the page instead, since
   * the person cannot fix it from here.
   */
  async function finish(
    link: LinkDescription,
    recovery: RecoverySecret,
    method: UnlockMethod,
    input?: string,
    quiet = false,
  ): Promise<boolean> {
    let secret: string;

    try {
      secret = await unlockBackup(recovery, method, input);
    } catch (err) {
      if (!quiet) {
        setError(
          err instanceof Error ? err.message : 'Could not unlock your backup.',
        );
      }

      return false;
    }

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

    return true;
  }

  async function unlockStep(
    p: Extract<Phase, { name: 'unlock' }>,
    method: UnlockMethod,
    input?: string,
  ) {
    setBusy(true);
    setError(undefined);

    try {
      await finish(p.link, p.recovery, method, input);
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

      const methods = unlockMethods(recovery, account.email);

      // The account alone opens it when it can; otherwise ask for the passkey
      // or code below.
      if (
        methods[0] === 'assisted' &&
        (await finish(link, recovery, 'assisted', undefined, true))
      ) {
        return;
      }

      // Pasting the secret always works, even when no other way is left.
      const rest: UnlockMethod[] = [
        ...methods.filter(m => m !== 'assisted'),
        'secret',
      ];

      // The press that got us here still counts as a gesture, so ask for the
      // passkey straight away. Cancelled or refused (Safari can, after the
      // network round trips), and the choices below stay.
      if (
        rest[0] === 'passkey' &&
        (await finish(link, recovery, 'passkey', undefined, true))
      ) {
        return;
      }

      setPhase({ name: 'unlock', link, recovery, methods: rest });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read your backup.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** One field takes either a recovery code (or v1 password) or the secret
   * itself; a secret is recognisable, so nobody has to pick which. */
  function submitKey(p: Extract<Phase, { name: 'unlock' }>, value: string) {
    if (!value.trim() || busy) return;

    const method: UnlockMethod = isSecret(value)
      ? 'secret'
      : p.methods.includes('password')
        ? 'password'
        : 'code';

    void unlockStep(p, method, value);
  }

  /** One sign-in, so one sign-out: the account and this browser's identity
   * both go, then the page asks for a sign-in again. */
  async function switchAccount() {
    setBusy(true);

    try {
      await signOutEverywhere({ agentSubject: agent?.subject });
      setAgent(undefined);
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
                {phase.methods.includes('passkey') ? (
                  <Button
                    type='button'
                    disabled={busy}
                    onClick={() => void unlockStep(phase, 'passkey')}
                  >
                    {busy ? 'Waiting for your passkey…' : 'Use your passkey'}
                  </Button>
                ) : null}
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    submitKey(phase, keyInput);
                  }}
                >
                  <Column gap='1rem'>
                    <InputWrapper>
                      <InputStyled
                        value={keyInput}
                        onChange={e => setKeyInput(e.target.value)}
                        // A pasted code or secret is complete: go on without
                        // a second press. A wrong one just shows the error.
                        onPaste={e => {
                          const pasted = e.clipboardData.getData('text');

                          if (pasted.trim()) {
                            e.preventDefault();
                            setKeyInput(pasted);
                            submitKey(phase, pasted);
                          }
                        }}
                        type='password'
                        autoComplete='off'
                        spellCheck={false}
                        disabled={busy}
                        placeholder={
                          phase.methods.includes('password')
                            ? 'Recovery password or secret'
                            : phase.methods.includes('code')
                              ? 'Recovery code or secret'
                              : 'Paste your secret'
                        }
                        aria-label='Recovery code or secret'
                      />
                    </InputWrapper>
                    {keyInput.trim() ? (
                      <Button type='submit' subtle disabled={busy}>
                        Continue
                      </Button>
                    ) : null}
                  </Column>
                </form>
                {error ? <CardError role='alert'>{error}</CardError> : null}
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
