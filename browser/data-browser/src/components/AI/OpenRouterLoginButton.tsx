import { useEffect, useState } from 'react';
import { ButtonLink } from '../ButtonLink';
import { paths } from '../../routes/paths';

const TEXT = 'Login with OpenRouter';
const AUTH_ENDPOINT = 'https://openrouter.ai/auth';

async function createSHA256CodeChallenge(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert ArrayBuffer to base64url string
  const byteArray = new Uint8Array(hashBuffer);
  const base64String = btoa(String.fromCharCode(...byteArray));

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
  const [challenge, setChallenge] = useState<string | null>(null);

  useEffect(() => {
    const randomString = crypto.randomUUID();
    createSHA256CodeChallenge(randomString).then(generatedChallenge => {
      setChallenge(generatedChallenge);
      sessionStorage.setItem(
        'atomic.ai.openrouter-code-verifier',
        randomString,
      );
    });
  }, []);

  if (!challenge) {
    return <ButtonLink href='#'>{TEXT}</ButtonLink>;
  }

  return <ButtonLink href={buildUrl(challenge)}>{TEXT}</ButtonLink>;
};
