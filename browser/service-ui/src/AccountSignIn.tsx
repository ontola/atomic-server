import { useRef, useState, type FormEvent, type ReactNode } from 'react';

/**
 * Every way into an Atomic account, in one order, wherever someone signs in:
 * the portal's sign-in page, the homepage signup panel and the app. Hosts
 * pass the actions; this owns which options exist and how they look, so no
 * screen can quietly drop one.
 */
export type AccountSignInCopy = {
  google: string;
  apple: string;
  github: string;
  passkey: string;
  /** "Sign in with secret", and its field once opened. */
  secret: string;
  secretLabel: string;
  secretSubmit: string;
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
    google: 'Google',
    apple: 'Apple',
    github: 'GitHub',
    passkey: 'Sign in with passkey',
    secret: 'Sign in with secret',
    secretLabel: 'Your Atomic secret',
    secretSubmit: 'Sign in',
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
          name: 'Apple',
          text: 'The same as Google, with your Apple Account. Apple can hide your real address and give us a private relay address that forwards to you. Whoever controls your Apple Account can sign in.',
        },
        {
          name: 'GitHub',
          text: "GitHub tells us your account number and your verified email addresses, and we use the main one. We ask to read nothing else, and do not keep GitHub's access. Whoever controls your GitHub account can sign in.",
        },
        {
          name: 'Email link',
          text: 'We send a link that works once, within 24 hours. Whoever can read your inbox can sign in. The email goes out through our mail provider, Postmark.',
        },
        {
          name: 'Secret',
          text: 'The key of your Atomic identity itself. It never leaves your device: it only signs a one-time challenge, and nobody else is involved. Whoever has it is you, so keep it somewhere safe, like a password manager.',
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
    google: 'Google',
    apple: 'Apple',
    github: 'GitHub',
    passkey: 'Inloggen met passkey',
    secret: 'Inloggen met secret',
    secretLabel: 'Je Atomic-secret',
    secretSubmit: 'Inloggen',
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
          name: 'Apple',
          text: 'Hetzelfde als Google, met je Apple-account. Apple kan je echte adres verbergen en ons een privé doorstuuradres geven. Wie je Apple-account beheert, kan inloggen.',
        },
        {
          name: 'GitHub',
          text: 'GitHub geeft ons je accountnummer en je geverifieerde e-mailadressen, en we gebruiken het hoofdadres. We vragen niets anders te lezen en bewaren de toegang tot GitHub niet. Wie je GitHub-account beheert, kan inloggen.',
        },
        {
          name: 'E-maillink',
          text: 'We sturen een link die één keer werkt, binnen 24 uur. Wie je inbox kan lezen, kan inloggen. De e-mail gaat via onze mailprovider Postmark.',
        },
        {
          name: 'Secret',
          text: 'De sleutel van je Atomic-identiteit zelf. Hij verlaat je apparaat nooit: hij ondertekent alleen een eenmalige uitdaging, en er komt niemand anders aan te pas. Wie hem heeft, kan als jou inloggen, dus bewaar hem veilig, bijvoorbeeld in een wachtwoordbeheerder.',
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
  appleHref = null,
  onApple,
  githubHref = null,
  onGitHub,
  onSecret,
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
  /** Where the Google option goes; `null` when the account service has
   * no Google client, which is the same answer on every screen. */
  googleHref: string | null;
  /** Instead of `googleHref`, for a host that has to do something first
   * (the desktop apps open Google in the system browser). */
  onGoogle?: () => void;
  /** The Apple option, as `googleHref`. */
  appleHref?: string | null;
  onApple?: () => void;
  /** The GitHub option, as `googleHref`. */
  githubHref?: string | null;
  onGitHub?: () => void;
  /** Sign in with the Atomic secret the person pastes. The host proves it
   * (it never leaves the device) and reports failures through `notice`.
   * Left out, the option is not shown: a host with its own secret field. */
  onSecret?: (secret: string) => void;
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
  const [secretOpen, setSecretOpen] = useState(false);
  const [secret, setSecret] = useState('');

  return (
    <div className='atomic-signin' data-signin-theme={theme}>
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
      <p className='atomic-signin-or' aria-hidden='true'>
        <span>{copy.or}</span>
      </p>
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
      ) : null}
      <div className='atomic-signin-row'>
        <ProviderOption
          href={googleHref}
          onPress={onGoogle}
          busy={busy}
          test='google-sign-in'
          mark={<GoogleMark />}
          label={copy.google}
        />
        <ProviderOption
          href={appleHref}
          onPress={onApple}
          busy={busy}
          test='apple-sign-in'
          mark={<AppleMark />}
          label={copy.apple}
        />
        <ProviderOption
          href={githubHref}
          onPress={onGitHub}
          busy={busy}
          test='github-sign-in'
          mark={<GitHubMark />}
          label={copy.github}
        />
      </div>
      {onSecret && !secretOpen ? (
        <button
          type='button'
          className='atomic-signin-option'
          disabled={busy}
          onClick={() => setSecretOpen(true)}
          data-test='secret-sign-in'
        >
          <SecretMark />
          <span>{copy.secret}</span>
        </button>
      ) : null}
      {onSecret && secretOpen ? (
        <form
          className='atomic-signin-email'
          onSubmit={e => {
            e.preventDefault();
            onSecret(secret.trim());
          }}
        >
          <label htmlFor={`${emailInputId}-secret`}>{copy.secretLabel}</label>
          <input
            id={`${emailInputId}-secret`}
            type='password'
            name='secret'
            value={secret}
            onChange={e => setSecret(e.target.value)}
            autoComplete='current-password'
            spellCheck={false}
            autoFocus
            required
            data-test='secret-input'
          />
          <button
            type='submit'
            className='atomic-signin-submit'
            disabled={busy || !secret.trim()}
          >
            {copy.secretSubmit}
          </button>
        </form>
      ) : null}
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

/** One sign-in provider option: a link, a button when the host has to do
 * something first, or nothing when the account service does not offer it. */
function ProviderOption({
  href,
  onPress,
  busy,
  test,
  mark,
  label,
}: {
  href: string | null;
  onPress?: () => void;
  busy: boolean;
  test: string;
  mark: ReactNode;
  label: string;
}) {
  if (href) {
    return (
      <a
        className='atomic-signin-option'
        href={href}
        aria-disabled={busy || undefined}
        onClick={e => busy && e.preventDefault()}
        data-test={test}
      >
        {mark}
        <span>{label}</span>
      </a>
    );
  }

  if (onPress) {
    return (
      <button
        type='button'
        className='atomic-signin-option'
        disabled={busy}
        onClick={onPress}
        data-test={test}
      >
        {mark}
        <span>{label}</span>
      </button>
    );
  }

  return null;
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

// Apple's logo, in the text colour, as Apple's guidelines allow for a
// button in the host's own style.
function AppleMark() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      aria-hidden='true'
      focusable='false'
      fill='currentColor'
    >
      <path d='M16.37 12.78c-.02-2.4 1.96-3.56 2.05-3.62-1.12-1.63-2.86-1.86-3.48-1.88-1.48-.15-2.89.87-3.64.87-.75 0-1.91-.85-3.14-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.22 1.2 9.58.8 1.16 1.75 2.45 2.99 2.41 1.2-.05 1.65-.78 3.1-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.17 2.9-2.33.92-1.34 1.29-2.64 1.31-2.71-.03-.01-2.51-.96-2.54-3.84zM13.98 5.73c.66-.8 1.11-1.92.99-3.03-.95.04-2.11.64-2.8 1.44-.61.71-1.15 1.85-1 2.94 1.06.08 2.15-.54 2.81-1.35z' />
    </svg>
  );
}

// GitHub's mark, in the text colour.
function GitHubMark() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 16 16'
      aria-hidden='true'
      focusable='false'
      fill='currentColor'
    >
      <path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z' />
    </svg>
  );
}

// A lock, in the text colour: the secret is the key to the identity itself.
function SecretMark() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      aria-hidden='true'
      focusable='false'
      fill='currentColor'
    >
      <path d='M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a2 2 0 0 1 1 3.73V19h-2v-1.27A2 2 0 0 1 12 14z' />
    </svg>
  );
}
