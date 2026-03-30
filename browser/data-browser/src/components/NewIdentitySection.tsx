import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Agent, JSCryptoProvider, core, server, useStore } from '@tomic/react';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { Button } from './Button';
import { Column, Row } from './Row';
import { CodeBlock } from './CodeBlock';
import { styled } from 'styled-components';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import Field from './forms/Field';

type Step =
  | 'idle'
  | 'creating'
  | 'profile'
  | 'creating-drive'
  | 'secret'
  | 'verify';

interface NewIdentitySectionProps {
  /** Called after the drive is created (or skipped). */
  onDone: () => void;
  /** Called after the agent and drive are created. Use this for any extra server-side steps (e.g. /setup). */
  onAfterCreate?: (driveSubject: string) => Promise<void>;
  /** If true, start creation immediately on mount without showing the button. */
  autoStart?: boolean;
  /**
   * If true, after confirming the secret is saved, the user is signed out and
   * must re-enter the secret to verify they saved it.
   */
  verifySecret?: boolean;
  /** Optional portal target for the step dots indicator. */
  stepIndicatorPortal?: Element | null;
}

interface IdentityData {
  secret: string;
  agentSubject: string;
  privateKey: string;
  profileName: string;
}

/**
 * Multi-step onboarding flow for creating a new identity.
 * Steps: idle → creating → profile → creating-drive → secret → verify → done
 *
 * After the username step we create one private drive (read/write: agent only) and set it as home.
 */
export function NewIdentitySection({
  onDone,
  onAfterCreate,
  autoStart = false,
  verifySecret = false,
  stepIndicatorPortal,
}: NewIdentitySectionProps) {
  const store = useStore();
  const { setAgent, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [step, setStep] = useState<Step>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    if (autoStart) {
      handleCreate();
    }
  }, []);

  // ─── Step: Create Identity ───────────────────────────────────────────────

  async function handleCreate() {
    setStep('creating');
    setLoading(true);
    setError(undefined);

    try {
      const agentKeys = await Agent.generateKeyPair();
      const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
      const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
      const newAgent = new Agent(agentProvider, agentDID);

      store.setAgent(newAgent);

      setIdentity({
        secret: '', // will be built after drive is created
        agentSubject: agentDID,
        privateKey: agentKeys.privateKey,
        profileName: '',
      });

      setStep('profile');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('idle');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Profile → private drive (automatic) ───────────────────────────

  function handleProfileSave(name: string) {
    const trimmed = name.trim();
    setIdentity(prev => (prev ? { ...prev, profileName: trimmed } : null));
    void createPersonalDrive(trimmed);
  }

  /** One private drive per user on this server; becomes default home / initialDrive. */
  async function createPersonalDrive(username: string) {
    if (!identity) return;

    setStep('creating-drive');
    setLoading(true);
    setError(undefined);

    try {
      const agent = store.getAgent();
      if (!agent || agent.subject === undefined) {
        throw new Error('No agent set');
      }

      const agentResource = await store.getResource(identity.agentSubject);
      if (username) {
        agentResource.set(core.properties.name, username);
      }

      const driveName = username ? `${username}'s Drive` : 'Personal';

      const resource = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: {
          [core.properties.name]: driveName,
          [core.properties.description]:
            'Your private space on this server. Only you can read and write here.',
          [core.properties.write]: [agent.subject],
          [core.properties.read]: [agent.subject],
        },
      });

      // Save the drive first, then persist the pointer on the Agent resource.
      // (Avoids races where the Agent commit is written before the Drive exists.)
      await resource.save();

      agentResource.set(core.properties.personalDrive, resource.subject);
      agentResource.push(server.properties.drives, [resource.subject]);
      await agentResource.save();

      const finalSecret = Agent.buildSecret(
        identity.privateKey,
        identity.agentSubject,
        resource.subject,
      );

      await saveAgentToIDB(finalSecret);

      setIdentity(prev => (prev ? { ...prev, secret: finalSecret } : null));

      const updatedAgent = await Agent.fromSecret(finalSecret);
      store.setAgent(updatedAgent);

      setDrive(resource.subject);

      if (onAfterCreate) {
        await onAfterCreate(resource.subject);
      }

      setStep('secret');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('profile');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Confirm Secret ───────────────────────────────────────────────

  function handleConfirmSecret() {
    if (!identity) return;

    if (verifySecret) {
      // Sign out and go to verify step
      setAgent(undefined);
      saveAgentToIDB(undefined);
      setStep('verify');
    } else {
      // Skip verify, we're done
      onDone();
    }
  }

  // ─── Step: Verify Secret ──────────────────────────────────────────────────

  async function handleVerify(trimmedInput: string) {
    if (!trimmedInput || !identity) return;

    setLoading(true);
    setError(undefined);

    try {
      const agent = await Agent.fromSecret(trimmedInput);
      await saveAgentToIDB(trimmedInput);
      setAgent(agent);

      const home = await fetchPersonalDriveSubject(store, agent);

      if (home) {
        setDrive(home);
        navigate(constructOpenURL(home));
      }

      onDone();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The secret is invalid. You can start over.',
      );
    } finally {
      setLoading(false);
    }
  }

  // ─── Start Over ──────────────────────────────────────────────────────────

  function handleStartOver() {
    setIdentity(null);
    setHasCopied(false);
    setError(undefined);
    setStep('idle');
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const stepIndicator = (
    <StepIndicator step={step} verifySecret={verifySecret} />
  );

  return (
    <Column gap='1.5rem'>
      {stepIndicatorPortal
        ? createPortal(stepIndicator, stepIndicatorPortal)
        : stepIndicator}

      {step === 'idle' && (
        <Column gap='1rem'>
          <p>
            Create a new Agent on this server. We will set your username and
            create a private drive as your home.
          </p>
          {error && <ErrorText>{error}</ErrorText>}
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? 'Generating...' : 'Create new identity'}
          </Button>
        </Column>
      )}

      {step === 'creating' && (
        <Column gap='1rem'>
          <p>Generating your identity...</p>
        </Column>
      )}

      {step === 'profile' && identity && (
        <ProfileStep
          error={error}
          loading={loading}
          onSave={handleProfileSave}
        />
      )}

      {step === 'creating-drive' && (
        <Column gap='1rem'>
          <p>Creating your personal drive…</p>
        </Column>
      )}

      {step === 'secret' && identity && (
        <SecretStep
          secret={identity.secret}
          hasCopied={hasCopied}
          onCopy={() => setHasCopied(true)}
          onConfirm={handleConfirmSecret}
          onStartOver={handleStartOver}
          verifySecret={verifySecret}
        />
      )}

      {step === 'verify' && identity && (
        <VerifyStep
          secret={identity.secret}
          onVerify={handleVerify}
          onStartOver={handleStartOver}
        />
      )}
    </Column>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

const STEPS_SECRET = ['profile', 'secret', 'verify'];
const STEPS_NO_SECRET = ['profile', 'secret'];

function StepIndicator({
  step,
  verifySecret,
}: {
  step: Step;
  verifySecret: boolean;
}) {
  const steps = verifySecret ? STEPS_SECRET : STEPS_NO_SECRET;
  const currentIndex = steps.indexOf(step);

  if (
    currentIndex === -1 ||
    step === 'idle' ||
    step === 'creating' ||
    step === 'creating-drive'
  ) {
    return null;
  }

  return (
    <StepDots>
      {steps.map((s, i) => (
        <StepDot key={s} active={i === currentIndex} done={i < currentIndex} />
      ))}
    </StepDots>
  );
}

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <Dot
      style={{
        background: active ? '#333' : done ? '#888' : '#ccc',
      }}
    />
  );
}

const Dot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
`;

const StepDots = styled.div.attrs({ 'data-step-dots': 'true' })`
  display: flex;
  gap: 6px;
  justify-content: center;
`;

function SecretStep({
  secret,
  hasCopied,
  onCopy,
  onConfirm,
  onStartOver,
  verifySecret,
}: {
  secret: string;
  hasCopied: boolean;
  onCopy: () => void;
  onConfirm: () => void;
  onStartOver: () => void;
  verifySecret: boolean;
}) {
  return (
    <Column gap='1rem'>
      <h3>Your new identity is ready</h3>
      <p>
        <strong>IMPORTANT:</strong> Save this secret key. It is the only way to
        access your data if you clear your browser cache or sign in from another
        device.
      </p>
      <StyledCodeBlock
        className='secret-protected'
        wordWrap
        content={secret}
        renderContent={content => {
          const raw = content ?? '';
          const [firstLine, ...rest] = raw.split('\n');
          const restText = rest.join('\n');

          return (
            <>
              <span data-code-text-first>{firstLine}</span>
              {restText ? (
                <span data-code-text-rest>{'\n' + restText}</span>
              ) : null}
            </>
          );
        }}
        onCopy={onCopy}
      />
      {hasCopied ? (
        <>
          <p>
            Are you sure you&apos;ve stored this secret somewhere safe? You
            cannot recover it if you lose it.
          </p>
          <Row gap='1rem'>
            <Button onClick={onConfirm}>
              {verifySecret
                ? "Yes, I've stored it — sign me out to verify"
                : "Yes, I've stored it safely"}
            </Button>
            <Button subtle onClick={onStartOver}>
              Start over
            </Button>
          </Row>
        </>
      ) : (
        <Button disabled>Copy the secret key to continue</Button>
      )}
    </Column>
  );
}

function VerifyStep({
  secret,
  onVerify,
  onStartOver,
}: {
  secret: string;
  onVerify: (input: string) => void;
  onStartOver: () => void;
}) {
  const [input, setInput] = useState('');

  return (
    <Column gap='1rem'>
      <h3>Verify your secret</h3>
      <p>
        You have been signed out to verify that you saved your secret. Enter it
        below to sign in. If you lost it, you can start over.
      </p>
      <Field label='Enter your Agent Secret' fieldId='agent-secret'>
        <InputWrapper>
          <InputStyled
            id='agent-secret'
            value={input}
            onChange={e => {
              const val = e.target.value;
              setInput(val);
              if (val.trim() === secret) {
                onVerify(val.trim());
              }
            }}
            type='password'
            placeholder='Paste your secret here'
            autoComplete='off'
            spellCheck='false'
            autoFocus
          />
        </InputWrapper>
      </Field>
      <Button subtle onClick={onStartOver}>
        Start over
      </Button>
    </Column>
  );
}

function ProfileStep({
  error,
  loading,
  onSave,
}: {
  error: string | undefined;
  loading: boolean;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    onSave(name.trim());
  }

  return (
    <Column gap='1rem'>
      <h3>Set your profile name!</h3>
      <p>Others can read this. You can change this later.</p>
      <form onSubmit={handleSave}>
        <Column gap='1rem'>
          <Field
            label='Profile Name'
            fieldId='profile-name'
            error={error ? new Error(error) : undefined}
          >
            <InputWrapper>
              <InputStyled
                id='profile-name'
                value={name}
                onChange={e => setName(e.target.value)}
                type='text'
                placeholder='Enter your name'
                autoComplete='off'
                autoFocus
                disabled={loading}
              />
            </InputWrapper>
          </Field>
          <Row gap='1rem'>
            <ContinueButton type='submit' disabled={loading || !name.trim()}>
              {loading ? 'Creating drive…' : 'Save & continue'}
            </ContinueButton>
          </Row>
        </Column>
      </form>
    </Column>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const StyledCodeBlock = styled(CodeBlock)`
  word-break: break-word;

  &.secret-protected [data-code-text-rest] {
    filter: blur(8px);
    user-select: none;
  }

  &.secret-protected:hover [data-code-text-rest],
  &.secret-protected:focus-within [data-code-text-rest] {
    filter: none;
    user-select: text;
  }

  & button {
    top: ${p => p.theme.size(1)};
    right: ${p => p.theme.size(1)};
  }
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;

const ContinueButton = styled(Button)`
  align-self: flex-start;
  padding-inline: 1rem;
`;
