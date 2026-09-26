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
import {
  approvalUrl,
  awaitDeviceLink,
  requestDeviceLink,
  type LinkRequest,
} from '../../helpers/managed/deviceLink';
import { openExternal } from '../../helpers/openExternal';
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

/**
 * The same options for an app that cannot hold the account cookie (the
 * desktop and Android apps, a self-hosted origin): each one opens the
 * portal in the system browser, straight at that option, with a device-link
 * code, and this screen continues once the code is approved there. Google
 * refuses to sign in inside an app window anyway.
 */
export function AccountSignInViaBrowser({
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
  const [request, setRequest] = useState<LinkRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const signedIn = useRef(onSignedIn);

  useEffect(() => {
    signedIn.current = onSignedIn;
  });

  useEffect(() => {
    let live = true;
    void getAccountProviders().then(p => live && setGoogle(p.google));

    return () => {
      live = false;
      waiting.current?.abort();
    };
  }, []);

  function wait(issued: LinkRequest) {
    if (waiting.current) return;

    const controller = new AbortController();
    waiting.current = controller;

    void awaitDeviceLink(portalUrl, issued, { signal: controller.signal })
      .catch(() => 'expired' as const)
      .then(outcome => {
        waiting.current = null;
        setRequest(null);

        if (controller.signal.aborted) return;

        if (outcome === 'linked') signedIn.current();
        else setError('That sign-in expired. Pick an option to start again.');
      });
  }

  async function open(via: 'google' | 'passkey' | 'email') {
    setBusy(true);
    setError(null);

    const issued =
      request ??
      (await requestDeviceLink(portalUrl).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err)),
      ));
    setBusy(false);

    if (issued instanceof Error) {
      setError(
        issued instanceof TypeError
          ? 'Could not reach your account. Check your connection and try again.'
          : issued.message,
      );

      return;
    }

    setRequest(issued);
    const url = new URL(approvalUrl(portalUrl, issued.user_code));
    url.searchParams.set('via', via);

    if (via === 'email' && email.trim()) {
      url.searchParams.set('email', email.trim());
    }

    await openExternal(url.toString());
    wait(issued);
  }

  return (
    <Themed>
      <AccountSignIn
        googleHref={null}
        onGoogle={google ? () => void open('google') : undefined}
        onPasskey={() => void open('passkey')}
        email={email}
        onEmailChange={setEmail}
        onSubmitEmail={e => {
          e.preventDefault();
          void open('email');
        }}
        busy={busy || disabled}
        theme={theme.darkMode ? 'dark' : 'light'}
        notice={
          error ? (
            <CardError role='alert'>{error}</CardError>
          ) : request ? (
            <Sent role='status' data-testid='link-user-code'>
              Finish in your browser, then approve the code{' '}
              <strong>{request.user_code}</strong>. This screen continues by
              itself.
            </Sent>
          ) : null
        }
      />
    </Themed>
  );
}
