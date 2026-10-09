import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { FaKey } from 'react-icons/fa6';
import { Agent, JSCryptoProvider, agentSubject } from '@tomic/react';
import { useWelcomeLayoutEffect } from '../hooks/useWelcomeLayoutEffect';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { paths } from '../routes/paths';
import { Button } from '../components/Button';
import { Column } from '../components/Row';
import { Spinner } from '../components/Spinner';
import { NewIdentitySection } from '../components/NewIdentitySection';
import { InputStyled, InputWrapper } from '../components/forms/InputStyles';
import {
  CardError,
  CardSubtitle,
  CardTitle,
  CtaButton,
  FooterBar,
  OnboardingCard,
  OnboardingWrap,
  Shell,
} from './getting-started/chrome';
import {
  AlreadyLinkedError,
  fetchOidcSession,
  linkOidcAgent,
  parseOidcHash,
  type OidcErrorCode,
  type OidcSession,
} from '../helpers/oidc/oidcClient';
import {
  MIN_PASSPHRASE_LENGTH,
  WrongPassphraseError,
  decryptSecret,
  encryptSecret,
} from '../helpers/oidc/recoveryBlob';
import { setOidcHandoff } from '../helpers/oidc/handoff';

type Phase =
  | { name: 'working' }
  | { name: 'failed'; message: string }
  | { name: 'create'; ticket: string; provider: string; replace: boolean }
  | { name: 'unlock'; ticket: string; provider: string; session: OidcSession }
  | {
      name: 'identity';
      keys: { privateKey: string; agentSubject: string };
    };

/**
 * Where the identity provider sends the browser back to (`/oidc/callback`
 * redirects here with a ticket in the URL fragment).
 *
 * The private key never leaves this browser: a new identity is created here and
 * linked to the provider account, and an existing one is recovered by
 * decrypting a blob only this passphrase opens. See `planning/oidc-sign-in.md`.
 */
export function OidcSignInPage(): JSX.Element {
  useWelcomeLayoutEffect();
  const { baseURL } = useSettings();
  const navigate = useNavigateWithTransition();
  const [phase, setPhase] = useState<Phase>({ name: 'working' });
  const started = useRef(false);

  useEffect(() => {
    // The fragment is read once and removed straight away, so the ticket is
    // never left in the address bar, history or a copied link.
    if (started.current) return;
    started.current = true;

    const found = parseOidcHash(window.location.hash);
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );

    if (!found) {
      setPhase({ name: 'failed', message: messageFor('expired') });

      return;
    }

    if (found.kind === 'error') {
      setPhase({ name: 'failed', message: messageFor(found.code) });

      return;
    }

    fetchOidcSession(baseURL, found.ticket)
      .then(session => {
        setPhase(
          session.linked
            ? {
                name: 'unlock',
                ticket: found.ticket,
                provider: session.name,
                session,
              }
            : {
                name: 'create',
                ticket: found.ticket,
                provider: session.name,
                replace: false,
              },
        );
      })
      .catch((e: unknown) => {
        setPhase({
          name: 'failed',
          message: e instanceof Error ? e.message : messageFor('provider'),
        });
      });
  }, [baseURL]);

  return (
    <Shell>
      <OnboardingWrap>
        <OnboardingCard>
          {phase.name === 'working' ? (
            <div role='status' aria-label='Signing in'>
              <Spinner />
            </div>
          ) : phase.name === 'failed' ? (
            <Column gap='1rem'>
              <CardTitle>Sign-in did not complete</CardTitle>
              <CardError role='alert'>{phase.message}</CardError>
              <CtaButton onClick={() => navigate(paths.welcome)}>
                Back to sign in
              </CtaButton>
            </Column>
          ) : phase.name === 'create' ? (
            <CreatePassphrase
              phase={phase}
              onLinked={keys => setPhase({ name: 'identity', keys })}
            />
          ) : phase.name === 'unlock' ? (
            <UnlockPassphrase
              phase={phase}
              onForgot={() =>
                setPhase({
                  name: 'create',
                  ticket: phase.ticket,
                  provider: phase.provider,
                  replace: true,
                })
              }
            />
          ) : (
            <NewIdentitySection
              autoStart
              navigateToDrive
              verifySecret={false}
              presetKeys={phase.keys}
              onDone={() => undefined}
            />
          )}
        </OnboardingCard>
        {phase.name === 'create' || phase.name === 'unlock' ? (
          <FooterBar>
            <Button
              subtle
              type='button'
              onClick={() => navigate(paths.welcome)}
            >
              Cancel
            </Button>
          </FooterBar>
        ) : null}
      </OnboardingWrap>
    </Shell>
  );
}

function messageFor(code: OidcErrorCode): string {
  switch (code) {
    case 'denied':
      return 'The sign-in was cancelled or refused.';
    case 'policy':
      return 'This account is not allowed to sign in to this server.';
    case 'expired':
      return 'The sign-in expired. Please start again.';
    default:
      return 'The identity provider could not be reached or gave an unusable answer. Please try again.';
  }
}

function CreatePassphrase({
  phase,
  onLinked,
}: {
  phase: Extract<Phase, { name: 'create' }>;
  onLinked: (keys: { privateKey: string; agentSubject: string }) => void;
}): JSX.Element {
  const { baseURL } = useSettings();
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);

    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);

      return;
    }

    if (passphrase !== repeat) {
      setError('The two passphrases are not the same.');

      return;
    }

    setBusy(true);

    try {
      // The key is made here and never sent anywhere; only a blob encrypted
      // under the passphrase leaves this browser.
      const keys = await Agent.generateKeyPair();
      const did = agentSubject(keys.publicKey);
      const signer = new Agent(new JSCryptoProvider(keys.privateKey), did);
      const recovery = await encryptSecret(
        Agent.buildSecret(keys.privateKey, did),
        passphrase,
      );

      await linkOidcAgent(baseURL, {
        ticket: phase.ticket,
        agentSubject: did,
        signer,
        recovery,
        replace: phase.replace,
      });
      onLinked({ privateKey: keys.privateKey, agentSubject: did });
    } catch (err) {
      setError(
        err instanceof AlreadyLinkedError
          ? 'This account already has an identity on this server. Sign in again to recover it.'
          : err instanceof Error
            ? err.message
            : 'Something went wrong.',
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)}>
      <Column gap='1rem'>
        <CardTitle>
          {phase.replace ? 'Start over' : `Welcome, ${phase.provider} user`}
        </CardTitle>
        <CardSubtitle>
          {phase.replace
            ? 'This creates a new identity and replaces the old link. Data owned by the old identity stays with whoever still has its key.'
            : 'Choose a recovery passphrase. It unlocks your identity on a new device after you sign in here. We cannot reset it.'}
        </CardSubtitle>
        <InputWrapper hasPrefix>
          <FaKey />
          <InputStyled
            type='password'
            name='recovery-passphrase'
            autoComplete='new-password'
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder='Recovery passphrase'
            aria-label='Recovery passphrase'
            disabled={busy}
            autoFocus
          />
        </InputWrapper>
        <InputWrapper hasPrefix>
          <FaKey />
          <InputStyled
            type='password'
            name='recovery-passphrase-repeat'
            autoComplete='new-password'
            value={repeat}
            onChange={e => setRepeat(e.target.value)}
            placeholder='Repeat the passphrase'
            aria-label='Repeat the recovery passphrase'
            disabled={busy}
          />
        </InputWrapper>
        {error ? <CardError role='alert'>{error}</CardError> : null}
        <CtaButton type='submit' disabled={busy}>
          {busy ? 'Creating your identity…' : 'Continue'}
        </CtaButton>
      </Column>
    </form>
  );
}

function UnlockPassphrase({
  phase,
  onForgot,
}: {
  phase: Extract<Phase, { name: 'unlock' }>;
  onForgot: () => void;
}): JSX.Element {
  const navigate = useNavigateWithTransition();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(e: FormEvent) {
    e.preventDefault();

    if (!phase.session.linked) return;

    setBusy(true);
    setError(undefined);

    try {
      const secret = await decryptSecret(phase.session.recovery, passphrase);
      const agent = await Agent.fromSecret(secret);

      if (agent.subject !== phase.session.agent) {
        throw new Error('The recovered identity does not match the account.');
      }

      // Same road as a pasted secret: the sign-in flow stores it, finds the
      // drive and opens the workspace.
      setOidcHandoff(secret);
      navigate(paths.welcome);
    } catch (err) {
      setError(
        err instanceof WrongPassphraseError || err instanceof Error
          ? err.message
          : 'Something went wrong.',
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)}>
      <Column gap='1rem'>
        <CardTitle>Unlock your identity</CardTitle>
        <CardSubtitle>
          Enter the recovery passphrase you chose when you first signed in.
        </CardSubtitle>
        <InputWrapper hasPrefix>
          <FaKey />
          <InputStyled
            type='password'
            name='recovery-passphrase'
            autoComplete='current-password'
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder='Recovery passphrase'
            aria-label='Recovery passphrase'
            disabled={busy}
            autoFocus
          />
        </InputWrapper>
        {error ? <CardError role='alert'>{error}</CardError> : null}
        <CtaButton type='submit' disabled={busy || passphrase.length === 0}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </CtaButton>
        <Button subtle type='button' onClick={onForgot} disabled={busy}>
          I forgot my passphrase
        </Button>
      </Column>
    </form>
  );
}
