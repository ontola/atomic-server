import { useEffect, useRef, useState, type FormEvent } from 'react';
import { styled, useTheme } from 'styled-components';
import { AccountSignIn } from '@tomic/service-ui';
import '@tomic/service-ui/styles.css';
import {
  getAccountProviders,
  googleSignInUrl,
  sendAccountEmailLink,
} from '../../helpers/managed/accountProviders';
import { signInWithAccountPasskey } from '../../helpers/managed/accountPasskey';
import { getManagedAccount } from '../../helpers/managed/session';
import { hasPasskeyApi } from '../../helpers/passkeySupport';
import { CardError } from './chrome';

const EMAIL_POLL_MS = 2000;

/**
 * The account's ways in, the same component and the same options as the
 * portal's sign-in page: Google, passkey, email link. `onSignedIn` runs once
 * this browser holds an account session, however it got one.
 */
export function AccountSignInPanel({
  portalUrl,
  disabled,
  onSignedIn,
}: {
  portalUrl: string;
  disabled?: boolean;
  onSignedIn: () => void;
}) {
  const theme = useTheme();
  const [google, setGoogle] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = useRef(onSignedIn);

  useEffect(() => {
    signedIn.current = onSignedIn;
  });

  useEffect(() => {
    let live = true;
    void getAccountProviders().then(p => live && setGoogle(p.google));

    return () => {
      live = false;
    };
  }, []);

  // The email link opens on the portal, in another tab or on the phone that
  // got the mail. The shared cookie is how this page hears about it.
  useEffect(() => {
    if (!sentTo) return;

    const timer = window.setInterval(() => {
      void getManagedAccount()
        .catch(() => null)
        .then(account => {
          if (account) {
            window.clearInterval(timer);
            signedIn.current();
          }
        });
    }, EMAIL_POLL_MS);

    return () => window.clearInterval(timer);
  }, [sentTo]);

  async function handlePasskey() {
    setBusy(true);
    setError(null);

    const outcome = await signInWithAccountPasskey(email).catch(
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    setBusy(false);

    if (outcome instanceof Error) setError(outcome.message);
    else if (outcome) onSignedIn();
  }

  async function handleEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError(null);

    const outcome = await sendAccountEmailLink(email).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    );
    setSending(false);

    if (outcome instanceof Error) {
      setError(outcome.message);

      return;
    }

    // Local development hands the link out instead of mailing it, built on
    // the requesting origin; the mailed one always opens on the portal.
    if (outcome) {
      const link = new URL(outcome);
      window.open(
        new URL(link.pathname + link.search, portalUrl).toString(),
        '_blank',
        'noopener',
      );
    }

    setSentTo(email.trim());
  }

  return (
    <Themed>
      <AccountSignIn
        googleHref={
          google ? googleSignInUrl(portalUrl, window.location.href) : null
        }
        onPasskey={() => void handlePasskey()}
        passkeySupported={hasPasskeyApi()}
        email={email}
        onEmailChange={setEmail}
        onSubmitEmail={e => void handleEmail(e)}
        busy={busy || disabled}
        sending={sending}
        theme={theme.darkMode ? 'dark' : 'light'}
        notice={
          error ? (
            <CardError role='alert'>{error}</CardError>
          ) : sentTo ? (
            <Sent role='status'>
              We sent a link to {sentTo}. Open it, then come back here: this
              page continues by itself.
            </Sent>
          ) : null
        }
      />
    </Themed>
  );
}

const Themed = styled.div`
  --service-accent: ${p => p.theme.colors.main};
  --service-on-accent: ${p => p.theme.colors.bg};
  --service-muted: ${p => p.theme.colors.textLight};
  --service-text: ${p => p.theme.colors.text};
  --service-border: ${p => p.theme.colors.bg2};
  --service-input-bg: ${p => p.theme.colors.bg};
  --service-radius: ${p => p.theme.radius};
`;

const Sent = styled.p`
  margin: 0;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;
