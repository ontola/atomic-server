/**
 * React UI chrome for edit-mode clones: a generic hook plus inline-editable
 * text. The app supplies a `CloneAdapter` (how to build/read/write ITS
 * content shape); this module supplies the activation lifecycle, the
 * degraded-mode banner text, and the contentEditable wiring.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createCloneStore,
  loadManifest,
  saveManifest,
  clearManifest,
  wipeLocalData,
  type CloneStoreOptions,
} from './index.js';

/**
 * App-supplied bridge between edit-mode's lifecycle and the app's own
 * content shape. `TContent` is whatever shape the app renders from (e.g. the
 * salespage's `SalespageContent`); `TManifest` is whatever the app needs to
 * reopen its clone (subjects, property map, ...) plus the store secret.
 */
export interface CloneAdapter<TContent, TManifest extends { secret: string }> {
  storageKey: string;
  storeOptions: Omit<CloneStoreOptions, 'secret'>;
  /** First activation: build the clone's resources from what is on screen,
   *  return the manifest needed to reopen it later. */
  create(store: Awaited<ReturnType<typeof createCloneStore>>['store'], current: TContent): Promise<TManifest>;
  /** Returning visitor: hydrate readable state from a stored manifest. */
  open(store: Awaited<ReturnType<typeof createCloneStore>>['store'], manifest: TManifest): Promise<void>;
  getContent(): TContent;
  onChange(cb: () => void): () => void;
}

type CloneStatus = 'inactive' | 'loading' | 'active' | 'error';

export interface CloneState<TContent> {
  status: CloneStatus;
  persistent: boolean;
  hasClone: boolean;
  createdAt?: number;
  content?: TContent;
  error?: string;
  start(current: TContent): void;
  stop(): void;
  reset(): void;
}

export function useCloneMode<TContent, TManifest extends { secret: string; createdAt: number }>(
  adapter: CloneAdapter<TContent, TManifest>,
): CloneState<TContent> {
  const [status, setStatus] = useState<CloneStatus>('inactive');
  const [hasClone, setHasClone] = useState(false);
  const [createdAt, setCreatedAt] = useState<number | undefined>();
  const [content, setContent] = useState<TContent | undefined>();
  const [persistent, setPersistent] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const unsubRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    setHasClone(localStorage.getItem(adapter.storageKey) !== null);
    // adapter is expected to be referentially stable (module-level or memoized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(
    (current: TContent) => {
      setStatus('loading');
      setError(undefined);
      (async () => {
        const existing = loadManifest<TManifest>(adapter.storageKey);
        const cloneStore = await createCloneStore({
          ...adapter.storeOptions,
          secret: existing?.secret,
        });

        let manifest = existing;
        if (manifest) {
          try {
            await adapter.open(cloneStore.store, manifest);
          } catch {
            // Stored manifest points at resources this session can't read
            // (e.g. the local DB never became available last time). Start over.
            manifest = undefined;
          }
        }
        if (!manifest) {
          manifest = await adapter.create(cloneStore.store, current);
          manifest = { ...manifest, secret: cloneStore.secret };
          if (cloneStore.persistent) {
            saveManifest(adapter.storageKey, manifest);
          }
        }

        unsubRef.current?.();
        unsubRef.current = adapter.onChange(() => setContent(adapter.getContent()));

        setContent(adapter.getContent());
        setCreatedAt(manifest.createdAt);
        setPersistent(cloneStore.persistent);
        setHasClone(true);
        setStatus('active');
      })().catch(e => {
        console.error('[edit-mode] failed to start:', e);
        setError(e?.message ?? String(e));
        setStatus('error');
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = undefined;
    setContent(undefined);
    setStatus('inactive');
  }, []);

  const reset = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = undefined;
    wipeLocalData().finally(() => {
      clearManifest(adapter.storageKey);
      setHasClone(false);
      setContent(undefined);
      setStatus('inactive');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, persistent, hasClone, createdAt, content, error, start, stop, reset };
}

/* ---------- inline editing context ---------- */

interface EditApi {
  active: boolean;
  commit(target: string, value: string): void;
}

const EditContext = createContext<EditApi>({ active: false, commit: () => {} });

export function EditModeProvider<TContent>({
  active,
  commit,
  children,
}: {
  active: boolean;
  commit: (target: string, value: string) => void;
  children: ReactNode;
}) {
  return (
    <EditContext.Provider value={{ active, commit }}>{children}</EditContext.Provider>
  );
}

/**
 * Inline-editable text. Plain text when inactive; contentEditable in edit
 * mode, committing on blur (or Enter, for single-line fields). `target` is
 * an opaque string your `commit` handler interprets (a field name, a
 * `subject:field` pair, whatever your content model needs).
 */
export function Editable({
  target,
  multiline = false,
  children,
}: {
  target: string;
  multiline?: boolean;
  children: string;
}) {
  const { active, commit } = useContext(EditContext);

  if (!active) return <>{children}</>;

  return (
    <span
      className={multiline ? 'tomic-editable tomic-editable-block' : 'tomic-editable'}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={e => {
        const next = (e.currentTarget.textContent ?? '').trim();
        if (next && next !== children) commit(target, next);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' && !multiline && !e.shiftKey) {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
    >
      {children}
    </span>
  );
}

export function CloneBanner<TContent>({
  clone,
  onResume,
  onKeepVersion,
}: {
  clone: CloneState<TContent>;
  onResume: () => void;
  onKeepVersion?: string;
}) {
  if (clone.status === 'inactive' && !clone.hasClone) return null;

  if (clone.status === 'loading') {
    return <div className="tomic-clone-banner">Making your copy…</div>;
  }

  if (clone.status === 'error') {
    return (
      <div className="tomic-clone-banner tomic-clone-banner-error">
        Could not start edit mode: {clone.error}
      </div>
    );
  }

  if (clone.status === 'active') {
    return (
      <div className="tomic-clone-banner">
        <strong>This is your copy.</strong>&nbsp;
        {clone.persistent
          ? 'Everything you change stays on this device. The real site is untouched. Click any text to edit it.'
          : "Edits live only in this tab (this browser could not claim local storage). The real site is untouched. Click any text to edit it."}
        <span className="tomic-clone-banner-actions">
          <button onClick={clone.stop}>View original</button>
          <button onClick={clone.reset}>Reset</button>
          {onKeepVersion && <a href={onKeepVersion}>Keep my version</a>}
        </span>
      </div>
    );
  }

  return (
    <div className="tomic-clone-banner tomic-clone-banner-muted">
      You have edits on this page
      {clone.createdAt ? ` from ${new Date(clone.createdAt).toLocaleDateString()}` : ''}.
      <span className="tomic-clone-banner-actions">
        <button onClick={onResume}>Continue editing</button>
        <button onClick={clone.reset}>Reset</button>
      </span>
    </div>
  );
}
