import React, { FormEvent, useState } from 'react';
import { Button } from './Button';
import { Column, Row } from './Row';
import Field from './forms/Field';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import { FaKey } from 'react-icons/fa6';
import { styled } from 'styled-components';

export type LoggedOutAgentPanelProps = {
  onCreateIdentityClick: () => void;
  /** Called when the user submits the sign-in form with a non-empty secret. */
  onSignInWithSecret: (secret: string) => void | Promise<void>;
  error?: Error | undefined;
  loading?: boolean;
  /** Defaults to `agent-secret` (matches User Settings). */
  fieldId?: string;
};

/**
 * Shared “no agent yet” UI: create a new identity, or sign in with a secret.
 * Used on User Settings and the root welcome gate.
 */
export function LoggedOutAgentPanel({
  onCreateIdentityClick,
  onSignInWithSecret,
  error,
  loading = false,
  fieldId = 'agent-secret',
}: LoggedOutAgentPanelProps) {
  const [secret, setSecret] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = secret.trim();
    if (!trimmed) {
      return;
    }

    await onSignInWithSecret(trimmed);
  }

  return (
    <Column gap='2rem'>
      <Column gap='1rem'>
        <h3>Create a new identity</h3>
        <p>
          Generate a new self-sovereign Agent and Drive on this server.
        </p>
        <Button type='button' onClick={onCreateIdentityClick}>
          Create new identity
        </Button>
      </Column>

      <Divider />

      <Column gap='1rem'>
        <h3>Sign in with existing secret</h3>
        <form onSubmit={handleSubmit}>
          <Column gap='1rem'>
            <Field
              label='Enter your Agent Secret'
              fieldId={fieldId}
              helper={
                "The Agent Secret is a long string of characters that encodes both the Subject and the Private Key. You can think of it as a combined username + password. Store it safely, and don't share it with others."
              }
              error={error}
            >
              <InputWrapper hasPrefix>
                <FaKey />
                <InputStyled
                  id={fieldId}
                  value={secret}
                  onChange={e => setSecret(e.target.value)}
                  type='password'
                  name='secret'
                  autoComplete='current-password'
                  spellCheck={false}
                />
              </InputWrapper>
            </Field>
            <Row gap='1rem'>
              <Button type='submit' disabled={loading || !secret.trim()}>
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </Row>
          </Column>
        </form>
      </Column>
    </Column>
  );
}

const Divider = styled.hr`
  width: 100%;
  border: none;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  margin: 0;
`;
