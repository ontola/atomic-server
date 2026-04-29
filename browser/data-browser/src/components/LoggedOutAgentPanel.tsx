import React, { FormEvent, useEffect, useRef, useState, type JSX } from 'react';
import { Button } from './Button';
import { Column, Row } from './Row';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import { FaKey } from 'react-icons/fa6';
import { styled } from 'styled-components';

export type LoggedOutAgentPanelProps = {
  /** Shown at the top of the card (page-level heading). */
  heading: string;
  /** Use `2` when the page already has an `h1` (e.g. welcome gate). */
  headingLevel?: 1 | 2;
  onCreateIdentityClick: () => void;
  /** Called when the user submits the sign-in form with a non-empty secret. */
  onSignInWithSecret: (secret: string) => void | Promise<void>;
  error?: Error | undefined;
  loading?: boolean;
  /** Defaults to `agent-secret` (matches User Settings). */
  fieldId?: string;
};

type Phase = 'pick' | 'secret';

/**
 * Centered card: create a new identity, or sign in with an agent secret (second step).
 * Used on User Settings and the root welcome gate.
 */
export function LoggedOutAgentPanel({
  heading,
  headingLevel = 1,
  onCreateIdentityClick,
  onSignInWithSecret,
  error,
  loading = false,
  fieldId = 'agent-secret',
}: LoggedOutAgentPanelProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [secret, setSecret] = useState('');
  const formRef = useRef<HTMLFormElement | null>(null);
  const lastSubmittedSecret = useRef<string>('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = secret.trim();

    if (!trimmed) {
      return;
    }

    await onSignInWithSecret(trimmed);
  }

  useEffect(() => {
    if (phase !== 'secret') return;
    if (loading) return;

    const trimmed = secret.trim();
    if (!trimmed) return;
    if (trimmed === lastSubmittedSecret.current) return;

    // Defer slightly so paste / IME input settles.
    const t = window.setTimeout(() => {
      lastSubmittedSecret.current = trimmed;
      formRef.current?.requestSubmit();
    }, 150);

    return () => window.clearTimeout(t);
  }, [loading, phase, secret]);

  return (
    <Card>
      <CardTitle as={headingLevel === 2 ? 'h2' : 'h1'}>{heading}</CardTitle>
      {phase === 'pick' ? (
        <Column gap='0.75rem'>
          <WideButton type='button' onClick={onCreateIdentityClick}>
            Create account
          </WideButton>
          <WideButton type='button' subtle onClick={() => setPhase('secret')}>
            Sign in
          </WideButton>
        </Column>
      ) : (
        <form ref={formRef} onSubmit={handleSubmit}>
          <Column gap='1rem'>
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
                placeholder='Agent secret'
                aria-label='Agent secret'
                autoFocus
              />
            </InputWrapper>
            {error ? <ErrorText role='alert'>{error.message}</ErrorText> : null}
            <Row gap='0.75rem' wrapItems>
              <Button
                type='button'
                subtle
                onClick={() => {
                  setPhase('pick');
                  setSecret('');
                }}
              >
                Back
              </Button>
              <Button type='submit' disabled={loading || !secret.trim()}>
                {loading ? 'Signing in…' : 'Continue'}
              </Button>
            </Row>
          </Column>
        </form>
      )}
    </Card>
  );
}

const Card = styled.div`
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

const CardTitle = styled.h1`
  margin: 0 0 ${p => p.theme.size(6)} 0;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
`;

const WideButton = styled(Button)`
  width: fit-content;
  min-width: 12.5rem;
  align-self: center;
  justify-content: center;
`;

const ErrorText = styled.p`
  margin: 0;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.alert};
`;
