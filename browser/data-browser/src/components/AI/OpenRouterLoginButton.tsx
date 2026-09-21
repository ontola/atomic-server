import { useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { ButtonLink } from '../ButtonLink';
import { paths } from '../../routes/paths';

const TEXT = 'Login with OpenRouter';
const AUTH_ENDPOINT = 'https://openrouter.ai/auth';

function createSHA256CodeChallenge(input: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = sha256(data);

  // Convert ArrayBuffer to base64url string
  const base64String = btoa(String.fromCharCode(...hash));

  // Convert base64 to base64url
  return base64String
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const buildUrl = (challenge: string) => {
  const url = new URL(AUTH_ENDPOINT);

  url.searchParams.set(
    'callback_url',
    `${location.origin}${paths.linkOpenRouter}`,
  );
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
};

export const OpenRouterLoginButton = () => {
  const [verifier] = useState(() => {
    // 32 random bytes encoded as hex satisfy PKCE's 43–128 character rule.
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  });
  const challenge = createSHA256CodeChallenge(verifier);
  const [error, setError] = useState<string>();

  return (
    <>
      <ButtonLink
        href={buildUrl(challenge)}
        onClick={event => {
          try {
            // Only the clicked link owns this attempt. Mounting another button
            // must not invalidate the verifier while OpenRouter is authorizing.
            localStorage.setItem(
              'atomic.ai.openrouter-code-verifier',
              verifier,
            );
            setError(undefined);
          } catch {
            event.preventDefault();
            setError(
              'Could not start OpenRouter login. Allow browser storage and try again.',
            );
          }
        }}
      >
        {TEXT}
      </ButtonLink>
      {error && <p role='alert'>{error}</p>}
    </>
  );
};
