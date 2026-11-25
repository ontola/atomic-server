import { useState } from 'react';
import { Button } from '@tomic/ui/components/Button';
import { Column } from '@tomic/ui/components/Row';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import type { UnlockMethod } from '../helpers/managed/recovery';
import { isAgentSecret } from '../helpers/verifyAgentSecret';
import { CardError } from '../views/getting-started/chrome';

type Props = {
  methods: UnlockMethod[];
  busy: boolean;
  error?: string;
  onUnlock: (method: UnlockMethod, input?: string) => void;
};

/**
 * The way to open an account backup: a passkey button and one field that takes
 * a recovery code, a v1 recovery password or the agent secret itself. A secret
 * is recognisable, so nobody has to pick which.
 */
export function UnlockBackupForm({ methods, busy, error, onUnlock }: Props) {
  const [value, setValue] = useState('');

  function submit(input: string) {
    if (!input.trim() || busy) return;

    onUnlock(
      isAgentSecret(input)
        ? 'secret'
        : methods.includes('password')
          ? 'password'
          : 'code',
      input,
    );
  }

  return (
    <Column gap='1rem'>
      {methods.includes('passkey') ? (
        <Button
          type='button'
          disabled={busy}
          onClick={() => onUnlock('passkey')}
        >
          Use your passkey
        </Button>
      ) : null}
      <form
        onSubmit={e => {
          e.preventDefault();
          submit(value);
        }}
      >
        <Column gap='1rem'>
          <InputWrapper>
            <InputStyled
              value={value}
              onChange={e => setValue(e.target.value)}
              // A pasted code or secret is complete: go on without a second
              // press. A wrong one just shows the error.
              onPaste={e => {
                const pasted = e.clipboardData.getData('text');

                if (pasted.trim()) {
                  e.preventDefault();
                  setValue(pasted);
                  submit(pasted);
                }
              }}
              type='password'
              autoComplete='off'
              spellCheck={false}
              disabled={busy}
              placeholder={
                methods.includes('password')
                  ? 'Recovery password or secret'
                  : methods.includes('code')
                    ? 'Recovery code or secret'
                    : 'Paste your secret'
              }
              aria-label='Recovery code or secret'
            />
          </InputWrapper>
          {value.trim() ? (
            <Button type='submit' subtle disabled={busy}>
              Continue
            </Button>
          ) : null}
        </Column>
      </form>
      {error ? <CardError role='alert'>{error}</CardError> : null}
    </Column>
  );
}
