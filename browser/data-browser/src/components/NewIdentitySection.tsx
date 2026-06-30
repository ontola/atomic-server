import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Agent, JSCryptoProvider, core, useStore } from '@tomic/react';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { Button } from './Button';
import { Column, Row } from './Row';
import { CodeBlock } from './CodeBlock';
import toast from 'react-hot-toast';
import { FaDownload } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import Field from './forms/Field';

type Step =
  | 'idle'
  | 'creating'
  | 'profile'
  | 'creating-drive'
  | 'recovery-backup'
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
  /** Prefill the profile-name field (e.g. from a SaaS account email). */
  defaultProfileName?: string;
  /**
   * If true, after creating the identity, offer to back up the agent secret
   * (encrypted with a recovery password) so the account can be restored. Only
   * makes sense when signed in to a cloud account that can store it.
   */
  offerRecoveryBackup?: boolean;
  /** Encrypt + store the secret. Called with the new secret and the user's
   * recovery password. Throws to surface an error in the backup step. */
  onBackupRecovery?: (secret: string, password: string) => Promise<void>;
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
  defaultProfileName,
  offerRecoveryBackup = false,
  onBackupRecovery,
}: NewIdentitySectionProps) {
  const store = useStore();
  const { setAgent, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [step, setStep] = useState<Step>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  /** True after the user copies the secret or saves the backup file. */
  const [secretBackedUp, setSecretBackedUp] = useState(false);

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

      // Set the display name on the agent resource
      const agentResource = store.getResourceLoading(identity.agentSubject, {
        newResource: true,
      });
      const publicKey = identity.agentSubject.replace('did:ad:agent:', '');

      await agentResource.set(core.properties.publicKey, publicKey);
      await agentResource.set(core.properties.isA, [core.classes.agent]);

      if (username) {
        await agentResource.set(core.properties.name, username);
      }

      await agentResource.save();

      const driveName = username ? `${username}'s Drive` : 'Personal';

      const resource = await store.createDrive(
        driveName,
        'Your private space on this server. Only you can read and write here.',
      );

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

      setStep(
        offerRecoveryBackup && onBackupRecovery ? 'recovery-backup' : 'secret',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('profile');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Back up secret (encrypted recovery) ───────────────────────────

  async function handleBackupRecovery(password: string) {
    if (!identity || !onBackupRecovery) {
      setStep('secret');

      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      await onBackupRecovery(identity.secret, password);
      setStep('secret');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not back up your secret. You can still save it yourself.',
      );
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
      console.error('Failed to verify secret:', e);
      setError('The secret is invalid. Make sure you copied it correctly.');
    } finally {
      setLoading(false);
    }
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
          defaultName={defaultProfileName}
        />
      )}

      {step === 'creating-drive' && (
        <Column gap='1rem'>
          <p>Creating your personal drive…</p>
        </Column>
      )}

      {step === 'recovery-backup' && identity && (
        <RecoveryBackupStep
          error={error}
          loading={loading}
          onBackup={handleBackupRecovery}
          onSkip={() => {
            setError(undefined);
            setStep('secret');
          }}
        />
      )}

      {step === 'secret' && identity && (
        <SecretStep
          secret={identity.secret}
          secretBackedUp={secretBackedUp}
          onCopy={() => setSecretBackedUp(true)}
          onDownloadBackup={() => setSecretBackedUp(true)}
          onConfirm={handleConfirmSecret}
          verifySecret={verifySecret}
        />
      )}

      {step === 'verify' && identity && (
        <VerifyStep secret={identity.secret} onVerify={handleVerify} />
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StepDots = styled.div.attrs(() => ({ 'data-step-dots': 'true' }) as any)`
  display: flex;
  gap: 6px;
  justify-content: center;
`;

function downloadSecretBackupFile(secret: string): void {
  const when = new Date().toISOString();
  const lines = [
    'Atomic Server — agent secret backup',
    '',
    'IMPORTANT: Store this file (or the secret line) somewhere only you can access.',
    'Without it you cannot sign in after clearing the browser or on another device.',
    'Anyone who gets this secret can access your account on this server.',
    '',
    `Created: ${when}`,
    '',
    '--- SECRET (single line; keep exactly as-is) ---',
    secret,
    '--- END ---',
    '',
  ];
  const blob = new Blob([lines.join('\n')], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `atomic-agent-backup-${when.slice(0, 10)}.txt`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function SecretStep({
  secret,
  secretBackedUp,
  onCopy,
  onDownloadBackup,
  onConfirm,
  verifySecret,
}: {
  secret: string;
  secretBackedUp: boolean;
  onCopy: () => void;
  onDownloadBackup: () => void;
  onConfirm: () => void;
  verifySecret: boolean;
}) {
  function handleDownload() {
    downloadSecretBackupFile(secret);
    toast.success(
      'Backup file downloaded — move it out of Downloads if you share this computer',
    );
    onDownloadBackup();
  }

  return (
    <Column gap='1rem'>
      <h3>Safely store your secret</h3>
      <p>
        <strong>IMPORTANT:</strong> You need this secret to sign in again. We do
        not store a copy you can reset like a normal password.
      </p>
      <p>
        <strong>Ways to keep it:</strong> a password manager (best),{' '}
        <strong>Save as file</strong> below and move it to a private folder, or
        copy into a <strong>locked note</strong> (Apple Notes, Google Keep,
        etc.)—not email or chat.
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
      <Row gap='0.75rem' wrapItems>
        <Button type='button' subtle onClick={handleDownload}>
          <FaDownload aria-hidden style={{ marginRight: '0.45em' }} />
          Save backup file…
        </Button>
      </Row>
      {secretBackedUp ? (
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
          </Row>
        </>
      ) : (
        <Button disabled>
          Copy the secret or save the backup file to continue
        </Button>
      )}
    </Column>
  );
}

function VerifyStep({
  secret,
  onVerify,
}: {
  secret: string;
  onVerify: (input: string) => void;
}) {
  const [input, setInput] = useState('');

  return (
    <Column gap='1rem'>
      <h3>Verify your secret</h3>
      <p>
        You have been signed out to verify that you saved your secret. Enter it
        below to sign in.
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
    </Column>
  );
}

function ProfileStep({
  error,
  loading,
  onSave,
  defaultName,
}: {
  error: string | undefined;
  loading: boolean;
  onSave: (name: string) => void;
  defaultName?: string;
}) {
  const [name, setName] = useState(defaultName ?? '');

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

function RecoveryBackupStep({
  error,
  loading,
  onBackup,
  onSkip,
}: {
  error: string | undefined;
  loading: boolean;
  onBackup: (password: string) => void;
  onSkip: () => void;
}) {
  const [password, setPassword] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!password.trim() || loading) return;

    onBackup(password.trim());
  }

  return (
    <Column gap='1rem'>
      <h3>Back up your secret?</h3>
      <p>
        This lets you recover your account if you lose your secret. We won't get
        access to your data — your secret is encrypted with the recovery
        password below before it leaves your device.
      </p>
      <form onSubmit={handleSubmit}>
        <Column gap='1rem'>
          <Field
            label='Recovery password'
            fieldId='recovery-password'
            error={error ? new Error(error) : undefined}
          >
            <InputWrapper>
              <InputStyled
                id='recovery-password'
                value={password}
                onChange={e => setPassword(e.target.value)}
                type='password'
                placeholder='Choose a recovery password'
                autoComplete='new-password'
                autoFocus
                disabled={loading}
              />
            </InputWrapper>
          </Field>
          <Row gap='1rem'>
            <ContinueButton
              type='submit'
              disabled={loading || !password.trim()}
            >
              {loading ? 'Backing up…' : 'Back up & continue'}
            </ContinueButton>
            <Button type='button' subtle onClick={onSkip} disabled={loading}>
              Skip, I&apos;ll save it myself
            </Button>
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
