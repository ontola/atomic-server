import { Button } from '@tomic/ui/components/Button';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@tomic/ui/components/Dialog/index';
import {
  DialogContext,
  DialogGlobalContextProvider,
} from '@tomic/ui/components/Dialog/DialogGlobalContextProvider';
import {
  useContext,
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
import { createTableDraftCommit } from './draftCommit.js';

export interface TablePropertyEditorProps<Prepared extends object> {
  draft: Prepared;
  disabled: boolean;
  onSubmit: () => void;
  onValidationChange: (valid: boolean) => void;
}
export interface TablePropertyDialogAction {
  key: 'cancel' | 'save' | 'retry' | 'remove';
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
  /** Removal uses the same retained failure lifecycle without requiring valid form fields. */
  remove?: (draft: Prepared) => Promise<void>;
  /** A backend may checkpoint a materialized identity during a partial save. */
  isDraftLocked?: (draft: Prepared) => boolean;
  Editor: ComponentType<TablePropertyEditorProps<Prepared>>;
  Frame?: ComponentType<TablePropertyDialogPresentation>;
  onClose: () => void;
  /** Explicit dismissal; never called for a successful save. */
  onDismiss?: (draft: Prepared | undefined) => void;
  /** Completion notification; called only for the current, successfully saved scope. */
  onSaved?: (draft: Prepared) => void;
  onError?: (error: Error) => void;
  messages?: Partial<{
    preparing: string;
    retry: string;
    save: string;
    saveLocked: string;
    cancel: string;
    cancelLocked: string;
    remove: string;
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
  remove,
  isDraftLocked,
  Editor,
  Frame = TablePropertyDialogFrame,
  onClose,
  onDismiss,
  onSaved,
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
  const [operation, setOperation] = useState<'save' | 'remove'>('save');
  const [closed, setClosed] = useState(false);
  const mounted = useRef(false);
  const closedRef = useRef(false);
  const pending = useRef<Promise<Prepared> | undefined>(undefined);
  const text = {
    preparing: 'Preparing column…',
    retry: 'Retry',
    save: 'Save',
    saveLocked: 'Save',
    cancel: 'Cancel',
    remove: 'Remove',
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
    if (closedRef.current || controller.getSnapshot().busy) return;

    try {
      onDismiss?.(prepared);
    } catch {
      /* Dismissal observers cannot trap the editor. */
    }

    close();
  };

  const submit = async (
    requested: 'save' | 'remove' = locked ? operation : 'save',
  ) => {
    if (!prepared || closedRef.current) return;
    if (requested === 'remove' && !remove) return;
    setOperation(requested);
    const result = await controller.run(
      () => (requested === 'remove' ? remove!(prepared) : save(prepared)),
      (requested === 'remove' || valid || locked) && canSave && !preparing,
    );
    if (!mounted.current || closedRef.current || result.status === 'stale')
      return;
    setLocked(!!isDraftLocked?.(prepared));

    if (result.status === 'saved') {
      close();

      try {
        onSaved?.(prepared);
      } catch {
        /* Completion observers cannot change a saved backend outcome. */
      }
    }

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
    ...(remove && !locked
      ? [
          {
            key: 'remove' as const,
            label: text.remove,
            disabled: state.busy || preparing || !prepared || !canSave,
            run: () => {
              void submit('remove');
            },
          },
        ]
      : []),
    {
      key: 'cancel',
      label: locked ? (messages?.cancelLocked ?? text.cancel) : text.cancel,
      disabled: state.busy,
      run: cancel,
    },
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
          label: locked ? text.saveLocked : text.save,
          disabled:
            state.busy ||
            preparing ||
            !prepared ||
            (!valid && !locked) ||
            !canSave,
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

export function TablePropertyDialogFrame(
  props: TablePropertyDialogPresentation,
) {
  const { portal } = useContext(DialogContext);

  return portal.current ? (
    <SharedPropertyFrame {...props} />
  ) : (
    <DialogGlobalContextProvider>
      <SharedPropertyFrame {...props} />
    </DialogGlobalContextProvider>
  );
}

function SharedPropertyFrame({
  title,
  children,
  actions,
  busy,
  canClose,
  onCancel,
}: TablePropertyDialogPresentation) {
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // A standalone dialog's portal is attached during the first commit.
  if (!mounted) return null;

  return (
    <Dialog
      show
      labelledBy={titleId}
      aria-busy={busy}
      hideOnboardingFeedback
      disableLightDismiss={!canClose}
      onClose={() => {
        if (canClose) onCancel();
      }}
      onClosed={() => {}}
    >
      <DialogTitle>
        <h2 id={titleId}>{title}</h2>
      </DialogTitle>
      <DialogContent>{children}</DialogContent>
      <DialogActions>
        {actions.map(action => (
          <Button
            key={action.key}
            type='button'
            disabled={action.disabled}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ))}
      </DialogActions>
    </Dialog>
  );
}
