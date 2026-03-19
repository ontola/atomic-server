import React, { useEffect, useState } from 'react';
import { Agent, JSCryptoProvider, core, useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { Button } from './Button';
import { Column } from './Row';
import { CodeBlock } from './CodeBlock';
import { styled } from 'styled-components';

interface NewIdentitySectionProps {
  /** Called after the agent and drive are created. Use this for any extra server-side steps (e.g. /setup). */
  onAfterCreate?: (driveDID: string) => Promise<void>;
  /** Called when the user clicks Done after copying their secret. */
  onDone: () => void;
  doneLabel?: string;
  /** If true, start creation immediately on mount without showing the button. */
  autoStart?: boolean;
}

/**
 * Shared UI for generating a new Agent + Drive and displaying the resulting secret.
 * Used by both the Onboarding page and the Agent Settings page.
 */
export function NewIdentitySection({
  onAfterCreate,
  onDone,
  doneLabel = "Yes, I've stored it safely",
  autoStart = false,
}: NewIdentitySectionProps) {
  const store = useStore();
  const { baseURL, setAgent } = useSettings();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [generatedSecret, setGeneratedSecret] = useState('');
  const [hasCopiedSecret, setHasCopiedSecret] = useState(false);

  useEffect(() => {
    if (autoStart) {
      handleCreate();
    }
  }, []);

  async function handleCreate() {
    setLoading(true);
    setError(undefined);

    try {
      const agentKeys = await Agent.generateKeyPair();
      const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
      const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
      const newAgent = new Agent(agentProvider, agentDID);

      store.setAgent(newAgent);

      const driveName = new URL(baseURL).host;
      const driveResource = await store.newResource({
        isA: 'https://atomicdata.dev/classes/Drive',
        noParent: true,
        propVals: {
          [core.properties.name]: driveName,
          [core.properties.write]: [agentDID],
          [core.properties.read]: [agentDID],
        },
      });

      await driveResource.save();
      const driveDID = driveResource.subject;

      await onAfterCreate?.(driveDID);

      const finalSecret = Agent.buildSecret(
        agentKeys.privateKey,
        agentDID,
        driveDID,
      );

      await saveAgentToIDB(finalSecret);
      setAgent(newAgent);
      setGeneratedSecret(finalSecret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (generatedSecret) {
    return (
      <Column gap='1rem'>
        <h3>Your new identity is ready</h3>
        <p>
          <strong>IMPORTANT:</strong> Save this secret key. It is the only way
          to access your data if you clear your browser cache or sign in from
          another device.
        </p>
        <StyledCodeBlock
          wordWrap
          content={generatedSecret}
          onCopy={() => setHasCopiedSecret(true)}
        />
        {hasCopiedSecret ? (
          <>
            <p>
              Are you sure you{"'"}ve stored this secret somewhere safe? You
              cannot recover it if you lose it.
            </p>
            <Button onClick={onDone}>{doneLabel}</Button>
          </>
        ) : (
          <Button disabled>Copy the secret key to continue</Button>
        )}
      </Column>
    );
  }

  return (
    <Column gap='1rem'>
      <h3>Create a new identity</h3>
      <p>Generate a new self-sovereign Agent and Drive on this server.</p>
      {error && <ErrorText>{error}</ErrorText>}
      <Button onClick={handleCreate} disabled={loading}>
        {loading ? 'Generating...' : 'Create new identity'}
      </Button>
    </Column>
  );
}

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
