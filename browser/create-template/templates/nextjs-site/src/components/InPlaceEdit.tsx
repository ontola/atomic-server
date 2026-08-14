'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Agent, core, useStore } from '@tomic/react';
import { EditModeProvider } from '@tomic/edit-mode/react';
import { cmsEditUrl } from '@/atomic/cmsEditUrl';
import { env } from '@/env';
import { useCurrentSubject } from '@/app/context/CurrentSubjectProvider';
import styles from './InPlaceEdit.module.css';

const STORAGE_KEY = 'atomic-cms-editor-secret';

export function editTarget(subject: string, property: string) {
  return `${subject}\n${property}`;
}

export const NAME_PROP = core.properties.name;
export const DESCRIPTION_PROP = core.properties.description;

type InPlaceEditApi = {
  editing: boolean;
  signedIn: boolean;
  enterEdit: () => void;
  exitEdit: () => void;
};

const InPlaceEditContext = createContext<InPlaceEditApi | null>(null);

export function useInPlaceEdit() {
  const ctx = useContext(InPlaceEditContext);

  if (!ctx) {
    throw new Error('useInPlaceEdit must be used within InPlaceEditProvider');
  }

  return ctx;
}

export function InPlaceEditProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const { currentSubject } = useCurrentSubject();
  const [editing, setEditing] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [promptSignIn, setPromptSignIn] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const secret = localStorage.getItem(STORAGE_KEY);

    if (!secret) {
      return;
    }

    try {
      store.setAgent(Agent.fromSecret(secret, 'js'));
      setSignedIn(true);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [store]);

  const signIn = useCallback(
    (secret: string) => {
      const trimmed = secret.trim();
      const agent = Agent.fromSecret(trimmed, 'js');
      store.setAgent(agent);
      localStorage.setItem(STORAGE_KEY, trimmed);
      setSignedIn(true);
      setPromptSignIn(false);
      setError(undefined);
      setEditing(true);
    },
    [store],
  );

  const signOut = useCallback(() => {
    store.setAgent(undefined);
    localStorage.removeItem(STORAGE_KEY);
    setSignedIn(false);
    setEditing(false);
    setPromptSignIn(false);
  }, [store]);

  const enterEdit = useCallback(() => {
    if (!signedIn) {
      setPromptSignIn(true);
      return;
    }

    setError(undefined);
    setEditing(true);
  }, [signedIn]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    setPromptSignIn(false);
  }, []);

  const commit = useCallback(
    (target: string, value: string) => {
      const nl = target.indexOf('\n');

      if (nl < 0) {
        return;
      }

      const subject = target.slice(0, nl);
      const property = target.slice(nl + 1);

      void (async () => {
        try {
          const resource = await store.getResource(subject);
          await resource.set(property, value, false);
          await resource.save();
          setError(undefined);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [store],
  );

  const dataBrowserHref = currentSubject
    ? cmsEditUrl(env.NEXT_PUBLIC_ATOMIC_CMS_URL, currentSubject)
    : undefined;

  return (
    <InPlaceEditContext.Provider
      value={{ editing, signedIn, enterEdit, exitEdit }}
    >
      <EditModeProvider active={editing} commit={commit}>
        {promptSignIn && (
          <SignInBanner
            onSubmit={signIn}
            onCancel={() => setPromptSignIn(false)}
            dataBrowserHref={dataBrowserHref}
          />
        )}
        {editing && (
          <EditingBanner
            error={error}
            onDone={exitEdit}
            onSignOut={signOut}
            dataBrowserHref={dataBrowserHref}
          />
        )}
        {children}
      </EditModeProvider>
    </InPlaceEditContext.Provider>
  );
}

function SignInBanner({
  onSubmit,
  onCancel,
  dataBrowserHref,
}: {
  onSubmit: (secret: string) => void;
  onCancel: () => void;
  dataBrowserHref?: string;
}) {
  const [secret, setSecret] = useState('');
  const [localError, setLocalError] = useState<string>();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    try {
      onSubmit(secret);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={styles.banner} data-testid='cms-signin'>
      <form className={styles.signInForm} onSubmit={handleSubmit}>
        <p>
          <strong>Sign in to edit this page.</strong> Paste your agent secret.
          It stays in this browser; the public site bundle never includes it.
        </p>
        <textarea
          className={styles.secret}
          data-testid='cms-agent-secret'
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder='Agent secret'
          autoComplete='off'
          spellCheck={false}
          rows={3}
          required
        />
        {localError && <p className={styles.error}>{localError}</p>}
        <span className={styles.actions}>
          <button type='submit' data-testid='cms-signin-submit'>
            Start editing
          </button>
          <button type='button' onClick={onCancel}>
            Cancel
          </button>
          {dataBrowserHref && (
            <a
              className={styles.bannerLink}
              data-testid='cms-data-browser-link'
              href={dataBrowserHref}
              rel='noreferrer'
              target='_blank'
            >
              Open in Data Browser
            </a>
          )}
        </span>
      </form>
    </div>
  );
}

function EditingBanner({
  error,
  onDone,
  onSignOut,
  dataBrowserHref,
}: {
  error?: string;
  onDone: () => void;
  onSignOut: () => void;
  dataBrowserHref?: string;
}) {
  return (
    <div className={styles.banner} data-testid='cms-editing-banner'>
      <p>
        <strong>Editing this page.</strong> Click highlighted text. Changes
        save when you click away.
      </p>
      {error && <p className={styles.error}>{error}</p>}
      <span className={styles.actions}>
        <button type='button' onClick={onDone}>
          Done
        </button>
        <button type='button' onClick={onSignOut}>
          Sign out
        </button>
        {dataBrowserHref && (
          <a
            className={styles.bannerLink}
            href={dataBrowserHref}
            rel='noreferrer'
            target='_blank'
          >
            Open in Data Browser
          </a>
        )}
      </span>
    </div>
  );
}
