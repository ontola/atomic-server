import { PRODUCT_NAME } from '../../helpers/managed';
import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { styled, css, keyframes } from 'styled-components';
import { useStore } from '@tomic/react';
import { Agent } from '@tomic/lib';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { useWelcomeLayoutEffect } from '../../hooks/useWelcomeLayoutEffect';
import { useSettings } from '../../helpers/AppSettings';
import { saveAgentToIDB } from '../../helpers/agentStorage';
import { fetchPersonalDriveSubject } from '../../helpers/personalDrive';
import { deviceHasDriveData } from '../../helpers/driveData';
import { constructOpenURL } from '../../helpers/navigation';
import { paths } from '../../routes/paths';
import { Button } from '../../components/Button';
import { Column } from '../../components/Row';
import { NewIdentitySection } from '../../components/NewIdentitySection';
import { getManagedAccount } from '../../helpers/managed/session';
import {
  fetchManagedInfo,
  accountCreationTarget,
  type AccountCreationTarget,
} from '../../helpers/managedServer';
import { createManagedSyncEnrollment } from '../../helpers/managed/enrollment';
import {
  buildEncryptedRecoverySecret,
  saveRecoverySecret,
  getRecoverySecret,
  decryptRecoverySecret,
  type RecoverySecret,
} from '../../helpers/managed/recovery';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { FaArrowLeft, FaKey } from 'react-icons/fa6';
import atomicServerLogoUrl from '../../../../../logo.svg?url';
import { ConnectDeviceStep } from './ConnectDeviceStep';
import {
  Shell,
  CardTitle,
  CardSubtitle,
  CardError,
  CtaButton,
  OnboardingWrap,
  OnboardingCard,
  FooterBar,
  BackLabel,
} from './chrome';

type Step = 'welcome' | 'signin' | 'create' | 'restore' | 'connect-device';

type RestoreState =
  | { phase: 'checking' }
  | { phase: 'no-session' }
  | { phase: 'no-backup'; email: string }
  | { phase: 'ready'; secret: RecoverySecret; email: string };

type Props = {
  subject: string;
  initialStep?: Step;
};

const swapIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

export function GettingStartedFlow({
  initialStep = 'welcome',
}: Props): React.JSX.Element {
  useWelcomeLayoutEffect();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { setAgent, setDrive, baseURL } = useSettings();
  // When the connected node is "managed" (reports a dashboard/portal URL via
  // /node-info), account creation goes through the portal (email
  // verification). Self-hosted / FOSS nodes report nothing here, so we keep the
  // local DID-agent creation unchanged.
  const [createTarget, setCreateTarget] = useState<AccountCreationTarget>({
    kind: 'local',
  });

  useEffect(() => {
    let cancelled = false;
    void fetchManagedInfo(baseURL).then(info => {
      if (!cancelled) setCreateTarget(accountCreationTarget(info));
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);
  // A user who just verified their email via the managed portal lands at
  // /app/welcome?from_portal=true. Skip the generic Create/Sign-in choice and go
  // straight into identity creation, with the username prefilled from their
  // account email and the new drive auto-enrolled in managed sync after create.
  const fromManaged =
    new URLSearchParams(window.location.search).get('from_portal') === 'true';
  // The portal hands the account email in the URL (`?from_portal=true&email=…`)
  // so we can prefill the profile name without an authenticated cross-origin
  // call back to the control plane (whose session cookie we don't have here).
  const emailParam =
    new URLSearchParams(window.location.search).get('email') || undefined;
  // A sign-in guard (clicking a drive you're not signed in for) sends the user
  // here with `next` carrying that drive's subject, so we open straight to the
  // sign-in step and return them to that drive afterwards (not their home).
  const nextDrive =
    new URLSearchParams(window.location.search).get('next') || undefined;
  const [step, setStep] = useState<Step>(
    fromManaged ? 'create' : nextDrive ? 'signin' : initialStep,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  // The drive a freshly signed-in device is missing, handed to the
  // connect-device step. Undefined when no drive resolved at all.
  const [missingDrive, setMissingDrive] = useState<string | undefined>();
  const stepDotsSlotRef = useRef<HTMLDivElement | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [managedUsername, setManagedUsername] = useState<string | undefined>(
    emailParam ? emailParam.split('@')[0] : undefined,
  );
  // Ready immediately for non-managed flows, or when the portal already handed
  // us the email in the URL (no fetch needed).
  const [managedReady, setManagedReady] = useState(
    !fromManaged || !!emailParam,
  );

  // Fallback for older portals that redirect without the `email` param: fetch
  // the managed account email and derive a default username before showing the
  // profile step, so the field comes prefilled. (Requires a managed session in
  // this origin; when absent, we just continue without a prefill.)
  useEffect(() => {
    if (!fromManaged || emailParam) return;
    let cancelled = false;

    void (async () => {
      try {
        const account = await getManagedAccount();

        if (!cancelled && account?.email) {
          setManagedUsername(account.email.split('@')[0]);
        }
      } catch {
        // Not signed in to the managed (or unreachable) — continue without a
        // prefill; the user can still type a name.
      } finally {
        if (!cancelled) setManagedReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromManaged, emailParam]);

  // Best-effort: enroll the freshly-created drive in managed sync. The identity
  // and drive already exist by the time this runs, so a failure here never
  // blocks onboarding — the user can retry from Managed Sync settings.
  // The new drive's subject, captured during onAfterCreate so the recovery
  // backup step can reference it.
  const newDriveSubject = useRef<string | undefined>(undefined);

  async function enrollManagedSync(driveSubject: string) {
    newDriveSubject.current = driveSubject;
    const agentSubject = store.getAgent()?.subject;

    if (!agentSubject) return;

    try {
      await createManagedSyncEnrollment({ driveSubject, agentSubject });
    } catch {
      // swallow — see above.
    }
  }

  // Encrypt the agent secret with the user's recovery password and store it on
  // the managed account, so they can restore it later ("Forgot your secret?").
  async function backupRecovery(secret: string, password: string) {
    const agentSubject = store.getAgent()?.subject;

    if (!agentSubject) {
      throw new Error('No agent to back up. Try again.');
    }

    const input = await buildEncryptedRecoverySecret({
      secret,
      password,
      agentSubject,
      driveSubject: newDriveSubject.current ?? null,
    });
    await saveRecoverySecret(input);
  }

  // ─── Restore ("Forgot your secret?") ─────────────────────────────────────
  const [restore, setRestore] = useState<RestoreState>({ phase: 'checking' });
  const [restorePassword, setRestorePassword] = useState('');

  // When the restore step opens, check for a managed session + a stored backup.
  useEffect(() => {
    if (step !== 'restore') return;
    let cancelled = false;
    setRestore({ phase: 'checking' });
    setError(undefined);

    void (async () => {
      try {
        const account = await getManagedAccount();

        if (!account?.email) {
          if (!cancelled) setRestore({ phase: 'no-session' });

          return;
        }

        const secret = await getRecoverySecret();

        if (cancelled) return;

        setRestore(
          secret
            ? { phase: 'ready', secret, email: account.email }
            : { phase: 'no-backup', email: account.email },
        );
      } catch {
        if (!cancelled) setRestore({ phase: 'no-session' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step]);

  async function handleRestore(e: FormEvent) {
    e.preventDefault();

    if (restore.phase !== 'ready' || loading) return;

    const password = restorePassword.trim();

    if (!password) return;

    setLoading(true);
    setError(undefined);

    try {
      const secret = await decryptRecoverySecret(restore.secret, password);
      // Reuse the normal sign-in path: parses the secret, sets the agent, and
      // navigates to the user's home drive.
      await handleSignInWithSecret(secret);
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error('Could not restore your account.'),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSignInWithSecret(secret: string) {
    setLoading(true);
    setError(undefined);

    try {
      const newAgent = await Agent.fromSecret(secret);
      setAgent(newAgent);
      await saveAgentToIDB(secret);

      // Where this sign-in wants to end up: the drive it came from, or the
      // account's own. One target, so there is one gate below — an early
      // return for the guard case is an early return around the gate.
      const target =
        nextDrive ?? (await fetchPersonalDriveSubject(store, newAgent));

      // Name the account's drive even when its data hasn't arrived: the Sync
      // page says "your data is on another device" about *that* drive, which
      // is true and useful. But when the account's drive cannot be named at
      // all, no drive is the honest answer — the value here otherwise falls
      // back to whatever was last open, or to the default, which is the
      // server's own root. Showing that as your workspace is how signing in
      // ends with somebody else's data on screen.
      setDrive(target ?? '');

      // A secret restores who you are, not what you have. So the app only
      // opens once the workspace is here to read: opening one we cannot read
      // shows an empty shell wearing its name, which reads as data loss.
      if (target && (await deviceHasDriveData(store, target))) {
        navigate(constructOpenURL(target));
      } else {
        setMissingDrive(target);
        setStep('connect-device');
      }
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Could not parse that secret.'),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitSignIn(e: FormEvent) {
    e.preventDefault();
    const trimmed = secretValue.trim();
    if (!trimmed || loading) return;
    await handleSignInWithSecret(trimmed);
  }

  // Pasting a secret submits immediately — no need to also click Continue.
  // Reads the clipboard directly rather than watching secretValue on a
  // timer: the previous version auto-submitted 150ms after ANY change to
  // the field, which meant (a) manually typing a secret triggered spurious
  // submit attempts (and error flashes) on every pause over 150ms, and (b)
  // it raced a manual Continue click — the timer could disable/replace the
  // button mid-click, which is exactly what made this flow flaky under
  // Playwright (and could confuse a real user clicking right after a
  // paste). Gating on the paste event itself removes both: typing never
  // auto-submits, and a paste-then-click is a no-op double submit guarded
  // by `loading`, not a race.
  function handlePasteSecret(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text').trim();
    if (!pasted || loading) return;
    void handleSignInWithSecret(pasted);
  }

  // The Paste button, for touch and for anyone who'd rather not hunt for the
  // field. Same paste-and-go as pasting into the field. Reading the clipboard
  // can be blocked (permissions, an unfocused tab) — fall back to filling the
  // field so the value is at least there to submit by hand.
  async function pasteSecretFromClipboard() {
    if (loading) return;

    try {
      const text = (await navigator.clipboard.readText()).trim();

      if (!text) return;

      setSecretValue(text);
      await handleSignInWithSecret(text);
    } catch {
      // Left to sign in manually — nothing was pasted, so say nothing.
    }
  }

  return (
    <Shell>
      {step === 'welcome' ? (
        <Swap key='welcome'>
          <WelcomeStack>
            <VisuallyHiddenH1>AtomicServer</VisuallyHiddenH1>
            <AtomicServerLogo
              src={atomicServerLogoUrl}
              alt=''
              decoding='async'
            />
            <ButtonStack>
              <CtaButton
                type='button'
                onClick={() => {
                  // Managed node → create the account on the portal
                  // (email verification). FOSS node → local identity.
                  if (createTarget.kind === 'portal') {
                    window.location.assign(createTarget.url);
                  } else {
                    setStep('create');
                  }
                }}
              >
                Create account
              </CtaButton>
              <CtaButton
                type='button'
                subtle
                onClick={() => {
                  setError(undefined);
                  setSecretValue('');
                  setStep('signin');
                }}
              >
                Sign in
              </CtaButton>
              <CtaButton
                type='button'
                subtle
                onClick={() => {
                  // No account needed: the demo mints a throwaway
                  // guest agent and runs entirely on this device.
                  navigate(paths.demo);
                }}
              >
                Try the live demo
              </CtaButton>
            </ButtonStack>
            {error ? <CardError role='alert'>{error.message}</CardError> : null}
          </WelcomeStack>
        </Swap>
      ) : step === 'signin' ? (
        <Swap key='signin'>
          <OnboardingWrap>
            <OnboardingCard>
              <Column gap='1rem'>
                <CardTitle>
                  {nextDrive ? 'Sign in to access this drive' : 'Sign in'}
                </CardTitle>
                {nextDrive ? (
                  <CardSubtitle>
                    Enter your agent secret to unlock this drive on this device.
                  </CardSubtitle>
                ) : null}
                <form onSubmit={handleSubmitSignIn}>
                  <Column gap='1rem'>
                    <InputWrapper hasPrefix>
                      <FaKey />
                      <InputStyled
                        value={secretValue}
                        onChange={e => setSecretValue(e.target.value)}
                        onPaste={handlePasteSecret}
                        type='password'
                        name='secret'
                        autoComplete='current-password'
                        spellCheck={false}
                        placeholder='Agent secret'
                        aria-label='Agent secret'
                        autoFocus
                      />
                    </InputWrapper>
                    {error ? (
                      <CardError role='alert'>{error.message}</CardError>
                    ) : null}
                    <Button
                      type='submit'
                      disabled={loading || !secretValue.trim()}
                    >
                      {loading ? 'Signing in…' : 'Continue'}
                    </Button>
                    <Button
                      type='button'
                      subtle
                      disabled={loading}
                      onClick={pasteSecretFromClipboard}
                    >
                      Paste from clipboard
                    </Button>
                    <Button
                      type='button'
                      subtle
                      onClick={() => {
                        setError(undefined);
                        setRestorePassword('');
                        setStep('restore');
                      }}
                    >
                      Forgot your secret?
                    </Button>
                    {nextDrive ? (
                      // The sign-in guard (ErrorPage → here with `next`) can't
                      // tell a returning user on a new device from a total
                      // stranger who's never had an account — both hit an
                      // unauthorized private resource the same way. Without
                      // this, a stranger has no visible path forward besides
                      // "Back" (not obvious it leads to account creation).
                      <Button
                        type='button'
                        subtle
                        onClick={() => {
                          setError(undefined);

                          if (createTarget.kind === 'portal') {
                            window.location.assign(createTarget.url);
                          } else {
                            setStep('create');
                          }
                        }}
                      >
                        Create account
                      </Button>
                    ) : null}
                  </Column>
                </form>
              </Column>
            </OnboardingCard>
            <FooterBar>
              <Button
                type='button'
                subtle
                onClick={() => {
                  setError(undefined);
                  setSecretValue('');
                  setStep('welcome');
                }}
              >
                <BackLabel>
                  <FaArrowLeft aria-hidden />
                  Back
                </BackLabel>
              </Button>
              <StepDotsSlot ref={stepDotsSlotRef} />
            </FooterBar>
          </OnboardingWrap>
        </Swap>
      ) : step === 'connect-device' ? (
        <Swap key='connect-device'>
          <ConnectDeviceStep
            drive={missingDrive}
            onConnected={target => {
              setDrive(target);
              navigate(constructOpenURL(target));
            }}
            onSkip={() => {
              // A deferral, not a dead end: the Sync page offers the same
              // route from its "data is on another device" card.
              //
              // Never into the drive itself, even though we can name it —
              // that is the empty shell this step exists to keep people out
              // of, and arriving in it by pressing Skip makes it look like
              // the workspace came back empty.
              navigate(paths.sync);
            }}
          />
        </Swap>
      ) : step === 'restore' ? (
        <Swap key='restore'>
          <OnboardingWrap>
            <OnboardingCard>
              <Column gap='1rem'>
                <CardTitle>Restore account</CardTitle>
                {restore.phase === 'checking' ? (
                  <p>{`Checking your ${PRODUCT_NAME} account…`}</p>
                ) : restore.phase === 'no-session' ? (
                  <Column gap='0.75rem'>
                    <p>
                      {`To restore your account, sign in to your ${PRODUCT_NAME} account first, then come back here.`}
                    </p>
                    <Button
                      type='button'
                      onClick={() => {
                        // Dev portal; in production this comes from the node's
                        // portalUrl (see managedServer.ts).
                        window.location.assign('http://localhost:49237');
                      }}
                    >
                      {`Sign in to your ${PRODUCT_NAME} account`}
                    </Button>
                  </Column>
                ) : restore.phase === 'no-backup' ? (
                  <p>
                    No recovery backup was found for {restore.email}. Account
                    recovery only works if you enabled it earlier.
                  </p>
                ) : (
                  <form onSubmit={handleRestore}>
                    <Column gap='1rem'>
                      <p>
                        Enter the recovery password you set for {restore.email}.
                      </p>
                      <InputWrapper hasPrefix>
                        <FaKey />
                        <InputStyled
                          value={restorePassword}
                          onChange={e => setRestorePassword(e.target.value)}
                          type='password'
                          autoComplete='current-password'
                          placeholder='Recovery password'
                          aria-label='Recovery password'
                          autoFocus
                        />
                      </InputWrapper>
                      {error ? (
                        <CardError role='alert'>{error.message}</CardError>
                      ) : null}
                      <Button
                        type='submit'
                        disabled={loading || !restorePassword.trim()}
                      >
                        {loading ? 'Restoring…' : 'Restore & sign in'}
                      </Button>
                    </Column>
                  </form>
                )}
              </Column>
            </OnboardingCard>
            <FooterBar>
              <Button
                type='button'
                subtle
                onClick={() => {
                  setError(undefined);
                  setRestorePassword('');
                  setStep('signin');
                }}
              >
                <BackLabel>
                  <FaArrowLeft aria-hidden />
                  Back
                </BackLabel>
              </Button>
              <StepDotsSlot ref={stepDotsSlotRef} />
            </FooterBar>
          </OnboardingWrap>
        </Swap>
      ) : (
        <Swap key='create'>
          <OnboardingWrap>
            <OnboardingCard>
              <Column gap='1.5rem'>
                {fromManaged && !managedReady ? (
                  <p>Setting up your account…</p>
                ) : (
                  <NewIdentitySection
                    autoStart
                    verifySecret
                    stepIndicatorPortal={stepDotsSlotRef.current}
                    defaultProfileName={managedUsername}
                    offerRecoveryBackup={fromManaged}
                    onBackupRecovery={fromManaged ? backupRecovery : undefined}
                    onAfterCreate={fromManaged ? enrollManagedSync : undefined}
                    onDone={() => {
                      // After verify, NewIdentitySection navigates to personalDrive / home
                    }}
                  />
                )}
              </Column>
            </OnboardingCard>
            <FooterBar>
              <Button subtle type='button' onClick={() => setStep('welcome')}>
                <BackLabel>
                  <FaArrowLeft aria-hidden />
                  Back
                </BackLabel>
              </Button>
              <StepDotsSlot ref={stepDotsSlotRef} />
            </FooterBar>
          </OnboardingWrap>
        </Swap>
      )}
    </Shell>
  );
}

const Swap = styled.div`
  width: 100%;
  animation: ${swapIn} 220ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const WelcomeStack = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${p => p.theme.size(9)};
  width: 100%;
  max-width: 22rem;
  margin-inline: auto;
  text-align: center;
`;

const ButtonStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
`;

const VisuallyHiddenH1 = styled.h1`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
`;

const AtomicServerLogo = styled.img`
  width: 100%;
  max-width: min(30rem, 92vw);
  height: auto;
  display: block;
  margin-inline: auto;

  @media (min-width: 56em) {
    margin-inline: 0;
  }

  ${p =>
    p.theme.darkMode &&
    css`
      filter: brightness(0) invert(1);
    `}
`;

const StepDotsSlot = styled.div`
  min-height: 1.25rem;

  & [data-step-dots='true'] {
    display: flex;
    justify-content: center;
    gap: 6px;
  }
`;
