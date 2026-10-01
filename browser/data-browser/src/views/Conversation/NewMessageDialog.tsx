import { isAgentSubject } from '@tomic/react';
import { useState } from 'react';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorLook } from '../../components/ErrorLook';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '../../components/forms/InputStyles';
import { useOpenConversation } from '../../helpers/conversations/useConversations';

/**
 * Starts a conversation with someone by their Atomic ID. The other way in is
 * the "Message" item on any avatar.
 */
export function NewMessageDialogBody({ onDone }: { onDone: () => void }) {
  const [agent, setAgent] = useState('');
  const [error, setError] = useState<Error | undefined>();
  const { openConversation, busy } = useOpenConversation();
  const trimmed = agent.trim();
  const valid = isAgentSubject(trimmed);

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();

    if (!valid) return;

    setError(undefined);

    try {
      await openConversation([trimmed]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return (
    <>
      <Dialog.Title>
        <h1>New message</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Form id='new-message-form' onSubmit={start}>
          <LabelStyled htmlFor='new-message-agent'>Who</LabelStyled>
          <InputWrapper $invalid={trimmed !== '' && !valid}>
            <InputStyled
              id='new-message-agent'
              autoFocus
              placeholder='did:ad:agent:…'
              value={agent}
              onChange={e => setAgent(e.target.value)}
              disabled={busy}
            />
          </InputWrapper>
          <Hint>
            Paste their Atomic ID. They find it under their account. Only the
            two of you can read what you send.
          </Hint>
          {error && <ErrorLook>{error.message}</ErrorLook>}
        </Form>
      </Dialog.Content>
      <Dialog.Actions>
        <Button subtle onClick={onDone}>
          Cancel
        </Button>
        <Button type='submit' form='new-message-form' disabled={!valid || busy}>
          {busy ? 'Starting…' : 'Start conversation'}
        </Button>
      </Dialog.Actions>
    </>
  );
}

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Hint = styled.p`
  margin: 0;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;
