import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { createTableDraftCommit } from './draftCommit.js';
import { tableTheme } from '../theme.js';

export interface TablePropertyEditorProps<Prepared extends object> {
  draft: Prepared;
  disabled: boolean;
  onSubmit: () => void;
  onValidationChange: (valid: boolean) => void;
}
export interface TablePropertyDialogAction {
  key: 'cancel' | 'save' | 'retry';
  label: string;
  disabled: boolean;
  run: () => void;
}
export interface TablePropertyDialogPresentation {
  title: string;
  children: ReactNode;
  actions: readonly TablePropertyDialogAction[];
  busy: boolean;
  canClose: boolean;
  onCancel: () => void;
}
export interface TablePropertyDialogProps<Prepared extends object> {
  open: boolean;
  scope: string;
  title: string;
  canSave?: boolean;
  prepare: () => Prepared | Promise<Prepared>;
  save: (draft: Prepared) => Promise<void>;
  /** A backend may checkpoint a materialized identity during a partial save. */
  isDraftLocked?: (draft: Prepared) => boolean;
  Editor: ComponentType<TablePropertyEditorProps<Prepared>>;
  Frame?: ComponentType<TablePropertyDialogPresentation>;
  onClose: () => void;
  onError?: (error: Error) => void;
  messages?: Partial<{
    preparing: string;
    retry: string;
    save: string;
    cancel: string;
    unavailable: string;
    locked: string;
  }>;
}

/** Page-owned property editing lifecycle. Preparation can be cancelled; backend
 * saves lock dismissal. The backend owns captured identity, validation and any
 * checkpoint/idempotence policy. Scope changes suppress stale UI completion. */
export function TablePropertyDialog<Prepared extends object>(
  props: TablePropertyDialogProps<Prepared>,
) {
  return props.open ? <PropertyIntent key={props.scope} {...props} /> : null;
}

function PropertyIntent<Prepared extends object>({
  scope,
  title,
  canSave = true,
  prepare,
  save,
  isDraftLocked,
  Editor,
  Frame = DefaultPropertyFrame,
  onClose,
  onError,
  messages,
}: TablePropertyDialogProps<Prepared>) {
  const controller = useMemo(() => createTableDraftCommit(scope), [scope]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [prepared, setPrepared] = useState<Prepared>();
  const [preparationError, setPreparationError] = useState<Error>();
  const [preparing, setPreparing] = useState(true);
  const [valid, setValid] = useState(false);
  const [locked, setLocked] = useState(false);
  const [closed, setClosed] = useState(false);
  const mounted = useRef(false);
  const closedRef = useRef(false);
  const pending = useRef<Promise<Prepared> | undefined>(undefined);
  const text = {
    preparing: 'Preparing column…',
    retry: 'Retry',
    save: 'Save',
    cancel: 'Cancel',
    unavailable:
      'Column editing is unavailable. Check access and the selected table.',
    locked:
      'This draft is locked after a partial save. Retry to finish saving.',
    ...messages,
  };

  const launchPreparation = () => {
    if (pending.current || closedRef.current) return;
    const task = Promise.resolve().then(prepare);
    pending.current = task;
    void task
      .then(
        value => {
          if (
            mounted.current &&
            !closedRef.current &&
            pending.current === task
          ) {
            setPrepared(value);
            setPreparing(false);
          }
        },
        failure => {
          if (
            mounted.current &&
            !closedRef.current &&
            pending.current === task
          ) {
            setPreparationError(
              failure instanceof Error ? failure : new Error(String(failure)),
            );
            setPreparing(false);
          }
        },
      )
      .finally(() => {
        if (pending.current === task) pending.current = undefined;
      });
  };

  const initialize = useEffectEvent(() => launchPreparation());
  useEffect(() => {
    mounted.current = true;
    initialize();

    return () => {
      mounted.current = false;
      controller.invalidate();
    };
  }, [controller]);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    controller.invalidate();
    setClosed(true);
    onClose();
  };

  const cancel = () => {
    if (!prepared || !controller.getSnapshot().busy) close();
  };

  const submit = async () => {
    if (!prepared || closedRef.current) return;
    const result = await controller.run(
      () => save(prepared),
      valid && canSave && !preparing,
    );
    if (!mounted.current || closedRef.current || result.status === 'stale')
      return;
    setLocked(!!isDraftLocked?.(prepared));
    if (result.status === 'saved') close();

    if (result.status === 'failed') {
      try {
        onError?.(result.error);
      } catch {
        /* Notification cannot change the backend outcome. */
      }
    }
  };

  if (closed) return null;
  const actions: TablePropertyDialogAction[] = [
    { key: 'cancel', label: text.cancel, disabled: state.busy, run: cancel },
    !prepared && preparationError
      ? {
          key: 'retry',
          label: text.retry,
          disabled: preparing || !canSave,
          run: () => {
            if (canSave && !pending.current && !closedRef.current) {
              setPreparing(true);
              setPreparationError(undefined);
              launchPreparation();
            }
          },
        }
      : {
          key: 'save',
          label: text.save,
          disabled: state.busy || preparing || !prepared || !valid || !canSave,
          run: () => {
            void submit();
          },
        },
  ];

  return (
    <Frame
      title={title}
      actions={actions}
      busy={state.busy || preparing}
      canClose={!state.busy}
      onCancel={cancel}
    >
      {preparing && <p role='status'>{text.preparing}</p>}
      {!canSave && !state.busy && <p role='alert'>{text.unavailable}</p>}
      {(preparationError || state.error) && (
        <p role='alert'>{(preparationError ?? state.error)!.message}</p>
      )}
      {locked && <p role='status'>{text.locked}</p>}
      {prepared && (
        <div inert={state.busy || locked || !canSave}>
          <Editor
            draft={prepared}
            disabled={state.busy || locked || !canSave}
            onSubmit={() => {
              void submit();
            }}
            onValidationChange={setValid}
          />
        </div>
      )}
    </Frame>
  );
}

function DefaultPropertyFrame({
  title,
  children,
  actions,
  busy,
  onCancel,
}: TablePropertyDialogPresentation) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();

    return () => dialog?.close();
  }, []);

  return (
    <PropertyModal
      ref={ref}
      aria-labelledby={titleId}
      aria-busy={busy}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      <footer>
        {actions.map(action => (
          <button
            key={action.key}
            type='button'
            disabled={action.disabled}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
      </footer>
    </PropertyModal>
  );
}

const PropertyModal = styled.dialog`
  max-width: min(36rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  overflow: auto;
  box-sizing: border-box;
  padding: 1.5rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
  font:
    1rem/1.5 system-ui,
    sans-serif;
  box-shadow: ${p => tableTheme(p.theme).boxShadowIntense};
  &::backdrop {
    background: #0005;
  }
  h2 {
    margin-top: 0;
    font-size: 1.25rem;
  }
  footer {
    display: flex;
    justify-content: end;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }
  footer button {
    min-height: 2.25rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
    border-radius: ${p => tableTheme(p.theme).radius};
    background: ${p => tableTheme(p.theme).colors.bg1};
    color: inherit;
    font: inherit;
    cursor: pointer;
    &:disabled {
      opacity: 0.55;
      cursor: default;
    }
  }
`;
