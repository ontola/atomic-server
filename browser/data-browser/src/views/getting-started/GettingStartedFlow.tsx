import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { styled, css, keyframes } from 'styled-components';
import { useStore } from '@tomic/react';
import { Agent } from '@tomic/lib';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { useWelcomeLayoutEffect } from '../../hooks/useWelcomeLayoutEffect';
import { useSettings } from '../../helpers/AppSettings';
import { saveAgentToIDB } from '../../helpers/agentStorage';
import { fetchPersonalDriveSubject } from '../../helpers/personalDrive';
import { constructOpenURL } from '../../helpers/navigation';
import { paths } from '../../routes/paths';
import { Button } from '../../components/Button';
import { Column } from '../../components/Row';
import { NewIdentitySection } from '../../components/NewIdentitySection';
import { getCloudAccount } from '../../helpers/cloud/session';
import {
  fetchManagedInfo,
  accountCreationTarget,
  type AccountCreationTarget,
} from '../../helpers/managedServer';
import { createCloudSyncEnrollment } from '../../helpers/cloud/enrollment';
import {
  buildEncryptedRecoverySecret,
  saveRecoverySecret,
  getRecoverySecret,
  decryptRecoverySecret,
  type RecoverySecret,
} from '../../helpers/cloud/recovery';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { FaArrowLeft, FaKey } from 'react-icons/fa6';
import atomicServerLogoUrl from '../../../../../logo.svg?url';
import { welcomeBackgroundCss } from './welcomeBackground';

type Step = 'welcome' | 'signin' | 'create' | 'restore';

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
  // A user who just verified their email via the cloud portal lands at
  // /app/welcome?from_cloud=true. Skip the generic Create/Sign-in choice and go
  // straight into identity creation, with the username prefilled from their
  // account email and the new drive auto-enrolled in cloud sync after create.
  const fromCloud =
    new URLSearchParams(window.location.search).get('from_cloud') === 'true';
  // A sign-in guard (clicking a drive you're not signed in for) sends the user
  // here with `next` carrying that drive's subject, so we open straight to the
  // sign-in step and return them to that drive afterwards (not their home).
  const nextDrive =
    new URLSearchParams(window.location.search).get('next') || undefined;
  const [step, setStep] = useState<Step>(
    fromCloud ? 'create' : nextDrive ? 'signin' : initialStep,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const stepDotsSlotRef = useRef<HTMLDivElement | null>(null);
  const signInFormRef = useRef<HTMLFormElement | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const lastSubmittedSecret = useRef<string>('');
  const [cloudUsername, setCloudUsername] = useState<string | undefined>(
    undefined,
  );
  // For non-cloud flows there's nothing to wait for, so we're "ready" immediately.
  const [cloudReady, setCloudReady] = useState(!fromCloud);

  // Fetch the cloud account email and derive a default username before showing
  // the profile step, so the field comes prefilled.
  useEffect(() => {
    if (!fromCloud) return;
    let cancelled = false;

    void (async () => {
      try {
        const account = await getCloudAccount();

        if (!cancelled && account?.email) {
          setCloudUsername(account.email.split('@')[0]);
        }
      } catch {
        // Not signed in to the cloud (or unreachable) — continue without a
        // prefill; the user can still type a name.
      } finally {
        if (!cancelled) setCloudReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromCloud]);

  // Best-effort: enroll the freshly-created drive in cloud sync. The identity
  // and drive already exist by the time this runs, so a failure here never
  // blocks onboarding — the user can retry from Cloud Sync settings.
  // The new drive's subject, captured during onAfterCreate so the recovery
  // backup step can reference it.
  const newDriveSubject = useRef<string | undefined>(undefined);

  async function enrollCloudSync(driveSubject: string) {
    newDriveSubject.current = driveSubject;
    const agentSubject = store.getAgent()?.subject;

    if (!agentSubject) return;

    try {
      await createCloudSyncEnrollment({ driveSubject, agentSubject });
    } catch {
      // swallow — see above.
    }
  }

  // Encrypt the agent secret with the user's recovery password and store it on
  // the cloud account, so they can restore it later ("Forgot your secret?").
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

  // When the restore step opens, check for a cloud session + a stored backup.
  useEffect(() => {
    if (step !== 'restore') return;
    let cancelled = false;
    setRestore({ phase: 'checking' });
    setError(undefined);

    void (async () => {
      try {
        const account = await getCloudAccount();

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
        err instanceof Error ? err : new Error('Could not restore your account.'),
      );
    } finally {
      setLoading(false);
    }
  }

  const slogans: string[] = useMemo(
    () => ['Make your knowledge work for you.'],
    [],
  );

  async function handleSignInWithSecret(secret: string) {
    setLoading(true);
    setError(undefined);

    try {
      const newAgent = await Agent.fromSecret(secret);
      setAgent(newAgent);
      await saveAgentToIDB(secret);

      // Came in via a drive sign-in guard → return to that drive.
      if (nextDrive) {
        setDrive(nextDrive);
        navigate(constructOpenURL(nextDrive));

        return;
      }

      const home = await fetchPersonalDriveSubject(store, newAgent);

      if (home) {
        setDrive(home);
        navigate(constructOpenURL(home));
      } else {
        navigate(paths.agentSettings);
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

  useEffect(() => {
    if (step !== 'signin') return;
    if (loading) return;
    const trimmed = secretValue.trim();
    if (!trimmed) return;
    if (trimmed === lastSubmittedSecret.current) return;

    const t = window.setTimeout(() => {
      lastSubmittedSecret.current = trimmed;
      signInFormRef.current?.requestSubmit();
    }, 150);

    return () => window.clearTimeout(t);
  }, [loading, secretValue, step]);

  return (
    <Shell>
      {step === 'welcome' ? (
        <Swap key='welcome'>
          <Layout>
            <Pitch>
              <VisuallyHiddenH1>AtomicServer</VisuallyHiddenH1>
              <AtomicServerLogo
                src={atomicServerLogoUrl}
                alt=''
                decoding='async'
              />
              <Slogan>
                {slogans[Math.floor(Math.random() * slogans.length)]}
              </Slogan>
              <PropList>
                <li>
                  <strong>All-in-one workspace</strong>: documents, tables,
                  files, and APIs in one place, designed to stay coherent as it
                  grows.
                </li>
                <li>
                  <strong>Fast and lightweight</strong>: a snappy workspace and
                  API, small download, minimal dependencies, runs anywhere.
                </li>
                <li>
                  <strong>Open source</strong>: inspect, fork, and self-host.
                  Keep control of your data and avoid lock-in.
                </li>
                <li>
                  <strong>Future of the web</strong>: decentralized by design,
                  built for interoperability so your data and tools can work
                  together.
                </li>
                <li>
                  <strong>Feature complete by default</strong>: rights, history,
                  search, invites, realtime sync, collaboration, and AI chat
                  built in.
                </li>
              </PropList>
            </Pitch>
            <CardColumn>
              <Card>
                <CardTitle>Get started</CardTitle>
                <Column gap='0.75rem'>
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
                </Column>
                {error ? (
                  <CardError role='alert'>{error.message}</CardError>
                ) : null}
              </Card>
            </CardColumn>
          </Layout>
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
                <form ref={signInFormRef} onSubmit={handleSubmitSignIn}>
                  <Column gap='1rem'>
                    <InputWrapper hasPrefix>
                      <FaKey />
                      <InputStyled
                        value={secretValue}
                        onChange={e => setSecretValue(e.target.value)}
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
                      onClick={() => {
                        setError(undefined);
                        setRestorePassword('');
                        setStep('restore');
                      }}
                    >
                      Forgot your secret?
                    </Button>
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
      ) : step === 'restore' ? (
        <Swap key='restore'>
          <OnboardingWrap>
            <OnboardingCard>
              <Column gap='1rem'>
                <CardTitle>Restore account</CardTitle>
                {restore.phase === 'checking' ? (
                  <p>Checking your cloud account…</p>
                ) : restore.phase === 'no-session' ? (
                  <Column gap='0.75rem'>
                    <p>
                      To restore your account, sign in to your cloud account
                      first, then come back here.
                    </p>
                    <Button
                      type='button'
                      onClick={() => {
                        // Dev portal; in production this comes from the node's
                        // dashboardUrl (see managedServer.ts).
                        window.location.assign('http://localhost:49237');
                      }}
                    >
                      Sign in to your cloud account
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
                {fromCloud && !cloudReady ? (
                  <p>Setting up your account…</p>
                ) : (
                  <NewIdentitySection
                    autoStart
                    verifySecret
                    stepIndicatorPortal={stepDotsSlotRef.current}
                    defaultProfileName={cloudUsername}
                    offerRecoveryBackup={fromCloud}
                    onBackupRecovery={fromCloud ? backupRecovery : undefined}
                    onAfterCreate={fromCloud ? enrollCloudSync : undefined}
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

export const Shell = styled.div`
  /* height, not min-height: the parent body has overflow:hidden, so Shell
     owns the scroll on short windows. */
  height: ${p => p.theme.heights.fullPage};
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 'safe center' keeps content centered when it fits but falls back to
     flex-start when it overflows, so the top is reachable via scroll. */
  justify-content: safe center;
  padding: ${p => p.theme.size(7)} ${p => p.theme.size(5)};
  box-sizing: border-box;
  ${welcomeBackgroundCss}
`;

const Swap = styled.div`
  width: 100%;
  animation: ${swapIn} 220ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const Layout = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${p => p.theme.size(8)};
  width: 100%;
  max-width: 64rem;
  margin-inline: auto;

  @media (min-width: 56em) {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: ${p => p.theme.size(10)};
  }
`;

const Pitch = styled.div`
  flex: 1;
  min-width: 0;
  max-width: 34rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: start;
  gap: ${p => p.theme.size(5)};
`;

const Slogan = styled.h2`
  margin: 0;
  font-size: 1.15rem;
  font-weight: 650;
  letter-spacing: -0.01em;
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

const PropList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(4)};
  font-size: 0.95rem;
  line-height: 1.5;
  color: ${p => p.theme.colors.text};
  width: 100%;
  max-width: 46rem;

  strong {
    color: ${p => p.theme.colors.text};
    font-weight: 600;
  }

  li {
    margin: 0;
    position: relative;
    list-style: none;
    padding-inline-start: ${p => p.theme.size(5)};
  }

  li::before {
    content: '';
    position: absolute;
    inline-size: 0.45rem;
    block-size: 0.45rem;
    inset-inline-start: ${p => p.theme.size(2)};
    inset-block-start: 0.55em;
    border-radius: 999px;
    background: ${p => p.theme.colors.main};
    opacity: 0.9;
  }
`;

const CardColumn = styled.div`
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  width: 100%;

  @media (min-width: 56em) {
    width: auto;
    align-self: center;
  }
`;

export const Card = styled.div`
  box-sizing: border-box;
  width: 100%;
  max-width: 26.5rem;
  margin-inline: auto;
  padding: ${p => p.theme.size(7)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => p.theme.colors.bg1};
  box-shadow: ${p => p.theme.boxShadowSoft};
  backdrop-filter: blur(10px);
`;

const BackLabel = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
`;

export const CardTitle = styled.h2`
  margin: 0 0 ${p => p.theme.size(6)} 0;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
`;

const CardSubtitle = styled.p`
  margin: 0 0 ${p => p.theme.size(2)} 0;
  font-size: 0.95rem;
  color: ${p => p.theme.colors.textLight};
  text-align: center;
`;

export const CtaButton = styled(Button)`
  width: fit-content;
  min-width: 12.5rem;
  align-self: center;
  justify-content: center;
`;

const CardError = styled.p`
  margin: ${p => p.theme.size(4)} 0 0 0;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.alert};
`;

const OnboardingWrap = styled.div`
  width: 100%;
  max-width: 40rem;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

const OnboardingCard = styled.div`
  box-sizing: border-box;
  width: 100%;
  max-width: 36rem;
  margin-inline: auto;
  padding: ${p => p.theme.size(7)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => p.theme.colors.bg1};
  box-shadow: ${p => p.theme.boxShadowSoft};
  backdrop-filter: blur(10px);
`;

const FooterBar = styled.div`
  width: 100%;
  max-width: 36rem;
  margin-inline: auto;
  margin-top: ${p => p.theme.size(5)};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${p => p.theme.size(4)};
`;

const StepDotsSlot = styled.div`
  min-height: 1.25rem;

  & [data-step-dots='true'] {
    display: flex;
    justify-content: center;
    gap: 6px;
  }
`;
