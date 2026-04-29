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
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { FaArrowLeft, FaKey } from 'react-icons/fa6';
import atomicServerLogoUrl from '../../../../../logo.svg?url';
import { welcomeBackgroundCss } from './welcomeBackground';

type Step = 'welcome' | 'signin' | 'create';

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
  const { setAgent, setDrive } = useSettings();
  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const stepDotsSlotRef = useRef<HTMLDivElement | null>(null);
  const signInFormRef = useRef<HTMLFormElement | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const lastSubmittedSecret = useRef<string>('');

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
                  <CtaButton type='button' onClick={() => setStep('create')}>
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
                <CardTitle>Sign in</CardTitle>
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
      ) : (
        <Swap key='create'>
          <OnboardingWrap>
            <OnboardingCard>
              <Column gap='1.5rem'>
                {/* <CardTitle>Create account</CardTitle>Note  */}
                <NewIdentitySection
                  autoStart
                  verifySecret
                  stepIndicatorPortal={stepDotsSlotRef.current}
                  onAfterCreate={async () => {
                    // no-op: NewIdentitySection handles drive + secret persistence
                  }}
                  onDone={() => {
                    // After verify, NewIdentitySection navigates to personalDrive / home
                  }}
                />
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
