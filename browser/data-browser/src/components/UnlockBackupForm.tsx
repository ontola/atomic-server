import { useState } from 'react';
import { PasskeyMark } from '@tomic/service-ui';
import { ServiceTheme } from './ServiceTheme';
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

  // The shared sign-in classes, so this sits under the account's email
  // field and buttons at the same height, width and corners.
  return (
    <ServiceTheme className='atomic-signin'>
      {methods.includes('passkey') ? (
        <button
          type='button'
          className='atomic-signin-option'
          disabled={busy}
          onClick={() => onUnlock('passkey')}
        >
          <PasskeyMark />
          <span>Use your passkey</span>
        </button>
      ) : null}
      <form
        className='atomic-signin-email'
        onSubmit={e => {
          e.preventDefault();
          submit(value);
        }}
      >
        <input
          value={value}
          onChange={e => {
            setValue(e.target.value);
            // A secret either parses or it doesn't: sign in the moment
            // it is complete, whether typed or pasted.
            if (isAgentSecret(e.target.value)) submit(e.target.value);
          }}
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
          aria-label={
            methods.includes('password') || methods.includes('code')
              ? 'Recovery code or secret'
              : 'Agent secret'
          }
        />
        {value.trim() ? (
          <button
            type='submit'
            className='atomic-signin-submit'
            disabled={busy}
          >
            Continue
          </button>
        ) : null}
      </form>
      {error ? <CardError role='alert'>{error}</CardError> : null}
    </ServiceTheme>
  );
}
