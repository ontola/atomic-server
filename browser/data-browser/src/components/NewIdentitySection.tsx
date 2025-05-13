import React, { useEffect, useState } from 'react';
import { Agent, JSCryptoProvider, core, server, useStore } from '@tomic/react';
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

type Step = 'idle' | 'creating' | 'profile' | 'drive' | 'secret' | 'verify';

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
}

interface IdentityData {
  secret: string;
  agentSubject: string;
  privateKey: string;
  profileName: string;
}

/**
 * Multi-step onboarding flow for creating a new identity.
 * Steps: idle → creating → profile → drive → secret → verify → done
 */
export function NewIdentitySection({
  onDone,
  onAfterCreate,
  autoStart = false,
  verifySecret = false,
}: NewIdentitySectionProps) {
  const store = useStore();
  const { setAgent, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [step, setStep] = useState<Step>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [profileName, setProfileName] = useState('');

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

  // ─── Step: Profile ───────────────────────────────────────────────────────

  function handleProfileNext() {
    setStep('drive');
  }

  function handleProfileSave(name: string) {
    setProfileName(name);
    setIdentity(prev => (prev ? { ...prev, profileName: name } : null));
    setStep('drive');
  }

  function handleSkipProfile() {
    setProfileName('');
    setStep('drive');
  }

  // ─── Step: Drive ──────────────────────────────────────────────────────────

  async function handleCreateDrive(name: string) {
    if (!identity) return;

    setLoading(true);
    setError(undefined);

    try {
      const agent = store.getAgent();
      if (!agent || agent.subject === undefined) {
        throw new Error('No agent set');
      }

      const resource = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: {
          [core.properties.name]: name.trim(),
          [core.properties.description]:
            'This is your personal Atomic Data drive. Edit this description to tell visitors what this space is about.',
          [core.properties.write]: [agent.subject],
          [core.properties.read]: [agent.subject],
        },
      });

      await resource.save();

      // Add the new drive to the agent's drives array on the server
      const agentResource = await store.getResource(identity.agentSubject);
      const currentDrives =
        (agentResource.get(server.properties.drives) as string[]) || [];
      if (!currentDrives.includes(resource.subject)) {
        agentResource.set(server.properties.drives, [
          ...currentDrives,
          resource.subject,
        ]);
        await agentResource.save();
      }

      // Build the secret WITH the drive URL and persist it
      const finalSecret = Agent.buildSecret(
        identity.privateKey,
        identity.agentSubject,
        resource.subject,
      );

      // Save the secret with the drive URL
      await saveAgentToIDB(finalSecret);

      // Update identity with the complete secret
      setIdentity(prev => (prev ? { ...prev, secret: finalSecret } : null));

      // Update store agent with new secret so initialDrive is set
      const updatedAgent = await Agent.fromSecret(finalSecret);
      store.setAgent(updatedAgent);

      setDrive(resource.subject);

      if (onAfterCreate) {
        await onAfterCreate(resource.subject);
      }

      // Now show the secret step
      setStep('secret');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleSkipDrive() {
    if (!identity) return;

    // Build secret without drive URL (skip drive creation)
    const finalSecret = Agent.buildSecret(
      identity.privateKey,
      identity.agentSubject,
      undefined,
    );

    setIdentity(prev => (prev ? { ...prev, secret: finalSecret } : null));
    setStep('secret');
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

      // Save profile name AFTER verifying the secret
      await saveProfileName();

      // Navigate to the drive
      if (agent.initialDrive) {
        setDrive(agent.initialDrive);
        navigate(constructOpenURL(agent.initialDrive));
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
    setProfileName('');
    setError(undefined);
    setStep('idle');
  }

  async function saveProfileName() {
    if (!identity || !identity.profileName) return;

    try {
      const agentResource = await store.getResource(identity.agentSubject);
      agentResource.set(core.properties.name, identity.profileName);
      await agentResource.save();
    } catch (e) {
      console.error('Failed to save profile name:', e);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <Column gap='1.5rem'>
      <StepIndicator step={step} verifySecret={verifySecret} />

      {step === 'idle' && (
        <Column gap='1rem'>
          <p>Generate a new self-sovereign Agent and Drive on this server.</p>
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
          agentSubject={identity.agentSubject}
          onNext={handleProfileNext}
          onSave={handleProfileSave}
        />
      )}

      {step === 'drive' && (
        <DriveStep
          profileName={profileName}
          loading={loading}
          error={error}
          verifySecret={verifySecret}
          onCreate={handleCreateDrive}
          onSkip={handleSkipDrive}
        />
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

const STEPS_SECRET = ['profile', 'drive', 'secret', 'verify'];
const STEPS_NO_SECRET = ['profile', 'drive', 'secret'];

function StepIndicator({
  step,
  verifySecret,
}: {
  step: Step;
  verifySecret: boolean;
}) {
  const steps = verifySecret ? STEPS_SECRET : STEPS_NO_SECRET;
  const currentIndex = steps.indexOf(step);

  if (currentIndex === -1 || step === 'idle' || step === 'creating') {
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

const StepDots = styled.div`
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
      <StyledCodeBlock wordWrap content={secret} onCopy={onCopy} />
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
  agentSubject,
  onNext,
  onSave,
}: {
  agentSubject: string;
  onNext: () => void;
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
      <h3>You&apos;re signed in!</h3>
      <p>
        Now, set your profile name. Note that this is only set for this specific
        server, but you can use your secret also on other servers.
      </p>
      <form onSubmit={handleSave}>
        <Column gap='1rem'>
          <Field label='Profile Name' fieldId='profile-name'>
            <InputWrapper>
              <InputStyled
                id='profile-name'
                value={name}
                onChange={e => setName(e.target.value)}
                type='text'
                placeholder='Enter your name'
                autoComplete='off'
                autoFocus
              />
            </InputWrapper>
          </Field>
          <Row gap='1rem'>
            <Button type='submit' disabled={!name.trim()}>
              Save & Next
            </Button>
            <Button type='button' subtle onClick={onNext}>
              Skip
            </Button>
          </Row>
        </Column>
      </form>
    </Column>
  );
}

function DriveStep({
  profileName,
  loading,
  error,
  verifySecret,
  onCreate,
  onSkip,
}: {
  profileName: string;
  loading: boolean;
  error: string | undefined;
  verifySecret?: boolean;
  onCreate: (name: string) => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState(profileName ? `${profileName}'s Drive` : '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim()) {
      onCreate(name.trim());
    }
  }

  return (
    <Column gap='1rem'>
      <h3>
        {profileName
          ? `${profileName}, create your Drive`
          : 'Create your Drive'}
      </h3>
      <p>
        A Drive is your personal data space on this server. You can create more
        drives later.
      </p>
      <form onSubmit={handleSubmit}>
        <Column gap='1rem'>
          <Field
            label='Drive Name'
            fieldId='drive-name'
            error={error ? new Error(error) : undefined}
          >
            <InputWrapper>
              <InputStyled
                id='drive-name'
                value={name}
                onChange={e => setName(e.target.value)}
                type='text'
                autoComplete='off'
                autoFocus
              />
            </InputWrapper>
          </Field>
          <Row gap='1rem'>
            <Button type='submit' disabled={loading || !name.trim()}>
              {loading ? 'Creating...' : 'Create Drive'}
            </Button>
            {!verifySecret && (
              <Button type='button' subtle onClick={onSkip}>
                Skip
              </Button>
            )}
          </Row>
        </Column>
      </form>
    </Column>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const StyledCodeBlock = styled(CodeBlock)`
  word-break: break-word;

  & button {
    top: ${p => p.theme.size(1)};
    right: ${p => p.theme.size(1)};
  }
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;
