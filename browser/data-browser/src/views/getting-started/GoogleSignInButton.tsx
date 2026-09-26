import { css, styled } from 'styled-components';
import { useEffect, useState } from 'react';
import {
  getAccountProviders,
  googleSignInUrl,
} from '../../helpers/managed/accountProviders';

/**
 * "Continue with Google", straight to Google and back to this page. Renders
 * nothing where the account service has no Google client, so a deployment
 * without one looks exactly as before.
 */
export function GoogleSignInButton({
  portalUrl,
  disabled,
}: {
  portalUrl: string;
  disabled?: boolean;
}) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;
    void getAccountProviders().then(p => live && setAvailable(p.google));

    return () => {
      live = false;
    };
  }, []);

  if (!available) return null;

  return (
    <GoogleLink
      href={googleSignInUrl(portalUrl, window.location.href)}
      aria-disabled={disabled || undefined}
      onClick={e => disabled && e.preventDefault()}
      data-test='google-sign-in'
    >
      <GoogleMark />
      <span>Continue with Google</span>
    </GoogleLink>
  );
}

// Google's "G", in its four brand colours, as their sign-in guidelines ask.
function GoogleMark() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 48 48'
      aria-hidden='true'
      focusable='false'
    >
      <path
        fill='#EA4335'
        d='M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'
      />
      <path
        fill='#4285F4'
        d='M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'
      />
      <path
        fill='#FBBC05'
        d='M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'
      />
      <path
        fill='#34A853'
        d='M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'
      />
    </svg>
  );
}

// Neutral rather than the theme's main colour, per Google's branding
// guidelines, so it reads as a different way in.
const GoogleLink = styled.a`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.7rem 1rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid #747775;
  background: #ffffff;
  color: #1f1f1f;
  font-weight: 600;
  text-decoration: none;

  &:hover {
    background: #f2f2f2;
  }

  &[aria-disabled='true'] {
    opacity: 0.6;
    pointer-events: none;
  }

  ${p =>
    p.theme.darkMode &&
    css`
      background: #131314;
      border-color: #8e918f;
      color: #e3e3e3;

      &:hover {
        background: #1f1f20;
      }
    `}
`;
