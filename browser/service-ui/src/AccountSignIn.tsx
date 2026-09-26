import { useRef, type FormEvent, type ReactNode } from 'react';

/**
 * Every way into an Atomic account, in one order, wherever someone signs in:
 * the portal's sign-in page, the homepage signup panel and the app. Hosts
 * pass the actions; this owns which options exist and how they look, so no
 * screen can quietly drop one.
 */
export type AccountSignInCopy = {
  google: string;
  passkey: string;
  passkeyUnavailable: string;
  or: string;
  emailLabel: string;
  send: string;
  sending: string;
  info: AccountSignInInfoCopy;
};

/** "How safe is each option?": what each one trusts, and who can see what. */
export type AccountSignInInfoCopy = {
  open: string;
  title: string;
  close: string;
  options: { name: string; text: string }[];
  unlockTitle: string;
  /** When signing in alone opens the identity (assisted recovery). */
  unlockAssisted: string;
  /** When the identity also needs a passkey or recovery code. */
  unlockSeparate: string;
};

export const ACCOUNT_SIGN_IN_COPY: Record<'en' | 'nl', AccountSignInCopy> = {
  en: {
    google: 'Continue with Google',
    passkey: 'Sign in with passkey',
    passkeyUnavailable:
      'This browser does not support passkeys. Use Google or an email link instead.',
    or: 'or',
    emailLabel: 'Email',
    send: 'Email me a link',
    sending: 'Sending',
    info: {
      open: 'How safe is each option?',
      title: 'How safe is each option?',
      close: 'Close',
      options: [
        {
          name: 'Passkey',
          text: 'The safest. Your fingerprint, face or screen lock proves it is you. The key stays on your device or in your password manager, a fake website cannot use it, and nobody else is involved.',
        },
        {
          name: 'Google',
          text: 'Google confirms your email address to us, and that address is all we receive. Google learns that you signed in to Atomic. Whoever controls your Google account can sign in.',
        },
        {
          name: 'Email link',
          text: 'We send a link that works once, within 24 hours. Whoever can read your inbox can sign in. The email goes out through our mail provider, Postmark.',
        },
      ],
      unlockTitle: 'What signing in opens',
      unlockAssisted:
        'Any of these is enough to open your Atomic identity on a new device. That works because Atomic keeps a key that, together with our database, can unlock your encrypted identity backup. Our service only hands it to your own account right after you sign in. So this is convenient, but not zero-knowledge: someone who got hold of both that key and our database could open your identity. You can turn this off under account recovery in the app, and rely only on your passkey or recovery code.',
      unlockSeparate:
        'Signing in gives you your account: billing, hosted drives and your encrypted backup. Opening your Atomic identity on a new device also needs your passkey or recovery code, which Atomic cannot read.',
    },
  },
  nl: {
    google: 'Doorgaan met Google',
    passkey: 'Inloggen met passkey',
    passkeyUnavailable:
      'Deze browser ondersteunt geen passkeys. Gebruik Google of een e-maillink.',
    or: 'of',
    emailLabel: 'E-mail',
    send: 'Stuur me een link',
    sending: 'Bezig met versturen',
    info: {
      open: 'Hoe veilig is elke optie?',
      title: 'Hoe veilig is elke optie?',
      close: 'Sluiten',
      options: [
        {
          name: 'Passkey',
          text: 'Het veiligst. Je vingerafdruk, gezicht of schermvergrendeling bewijst dat jij het bent. De sleutel blijft op je apparaat of in je wachtwoordbeheerder, een nepwebsite kan hem niet gebruiken en er komt niemand anders aan te pas.',
        },
        {
          name: 'Google',
          text: 'Google bevestigt je e-mailadres aan ons, en dat adres is alles wat we krijgen. Google ziet dat je bij Atomic inlogt. Wie je Google-account beheert, kan inloggen.',
        },
        {
          name: 'E-maillink',
          text: 'We sturen een link die één keer werkt, binnen 24 uur. Wie je inbox kan lezen, kan inloggen. De e-mail gaat via onze mailprovider Postmark.',
        },
      ],
      unlockTitle: 'Wat inloggen opent',
      unlockAssisted:
        'Elk van deze opties is genoeg om je Atomic-identiteit op een nieuw apparaat te openen. Dat kan omdat Atomic een sleutel bewaart die, samen met onze database, je versleutelde identiteitsback-up kan openen. Onze dienst geeft die alleen aan je eigen account, direct nadat je bent ingelogd. Dat is handig, maar niet zero-knowledge: wie zowel die sleutel als onze database in handen krijgt, kan je identiteit openen. Je kunt dit uitzetten bij accountherstel in de app. Dan werken alleen je passkey of herstelcode nog.',
      unlockSeparate:
        'Inloggen geeft je je account: facturering, gehoste drives en je versleutelde back-up. Om je Atomic-identiteit op een nieuw apparaat te openen, heb je daarnaast je passkey of herstelcode nodig. Die kan Atomic niet lezen.',
    },
  },
};

export function AccountSignIn({
  googleHref,
  onGoogle,
  onPasskey,
  passkeySupported = true,
  email,
  onEmailChange,
  onSubmitEmail,
  busy = false,
  sending = false,
  copy = ACCOUNT_SIGN_IN_COPY.en,
  emailAutoComplete = 'username webauthn',
  emailInputId = 'atomic-signin-email',
  autoFocusEmail = false,
  notice,
  theme,
  assistedRecovery = false,
}: {
  /** Where "Continue with Google" goes; `null` when the account service has
   * no Google client, which is the same answer on every screen. */
  googleHref: string | null;
  /** Instead of `googleHref`, for a host that has to do something first
   * (the desktop apps open Google in the system browser). */
  onGoogle?: () => void;
  onPasskey: () => void;
  passkeySupported?: boolean;
  email: string;
  onEmailChange: (email: string) => void;
  onSubmitEmail: (event: FormEvent<HTMLFormElement>) => void;
  /** Something is in flight: every option waits. */
  busy?: boolean;
  /** The email link is on its way. */
  sending?: boolean;
  copy?: AccountSignInCopy;
  emailAutoComplete?: string;
  emailInputId?: string;
  autoFocusEmail?: boolean;
  /** Errors and confirmations, under the options. */
  notice?: ReactNode;
  /** The host's explicit theme; the system's when left out. */
  theme?: 'light' | 'dark';
  /** Signing in alone opens the identity; the info dialog says so. */
  assistedRecovery?: boolean;
}) {
  const info = useRef<HTMLDialogElement>(null);

  return (
    <div className='atomic-signin' data-signin-theme={theme}>
      {googleHref ? (
        <a
          className='atomic-signin-option'
          href={googleHref}
          aria-disabled={busy || undefined}
          onClick={e => busy && e.preventDefault()}
          data-test='google-sign-in'
        >
          <GoogleMark />
          <span>{copy.google}</span>
        </a>
      ) : onGoogle ? (
        <button
          type='button'
          className='atomic-signin-option'
          disabled={busy}
          onClick={onGoogle}
          data-test='google-sign-in'
        >
          <GoogleMark />
          <span>{copy.google}</span>
        </button>
      ) : null}
      {passkeySupported ? (
        <button
          type='button'
          className='atomic-signin-option'
          disabled={busy}
          onClick={onPasskey}
          data-test='passkey-sign-in'
        >
          <PasskeyMark />
          <span>{copy.passkey}</span>
        </button>
      ) : (
        <p className='atomic-signin-hint'>{copy.passkeyUnavailable}</p>
      )}
      <p className='atomic-signin-or' aria-hidden='true'>
        <span>{copy.or}</span>
      </p>
      <form className='atomic-signin-email' onSubmit={onSubmitEmail}>
        <label htmlFor={emailInputId}>{copy.emailLabel}</label>
        <input
          id={emailInputId}
          type='email'
          value={email}
          onChange={e => onEmailChange(e.target.value)}
          autoComplete={emailAutoComplete}
          autoFocus={autoFocusEmail}
          required
          data-test='email-sign-in'
        />
        <button
          type='submit'
          className='atomic-signin-submit'
          disabled={busy || sending}
        >
          {sending ? copy.sending : copy.send}
        </button>
      </form>
      {notice}
      <button
        type='button'
        className='atomic-signin-info-open'
        onClick={() => info.current?.showModal()}
        data-test='sign-in-info'
      >
        {copy.info.open}
      </button>
      <dialog
        ref={info}
        className='atomic-signin-info'
        aria-labelledby='atomic-signin-info-title'
        onClick={e => {
          // A press on the backdrop lands on the dialog itself.
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        <h2 id='atomic-signin-info-title'>{copy.info.title}</h2>
        <dl>
          {copy.info.options.map(option => (
            <div key={option.name}>
              <dt>{option.name}</dt>
              <dd>{option.text}</dd>
            </div>
          ))}
        </dl>
        <h3>{copy.info.unlockTitle}</h3>
        <p>
          {assistedRecovery
            ? copy.info.unlockAssisted
            : copy.info.unlockSeparate}
        </p>
        <form method='dialog'>
          <button type='submit' className='atomic-signin-submit'>
            {copy.info.close}
          </button>
        </form>
      </dialog>
    </div>
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

// A key, in the text colour: the passkey sits beside Google as an equal.
function PasskeyMark() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      aria-hidden='true'
      focusable='false'
      fill='currentColor'
    >
      <path d='M7 14a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm5.65-4A6 6 0 1 0 12.65 14H16v3h3v-3h2v-4z' />
    </svg>
  );
}
