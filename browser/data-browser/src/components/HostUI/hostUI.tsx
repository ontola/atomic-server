import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import toast from 'react-hot-toast';
import { isViewKeyEvent } from '@tomic/plugin';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import { DropdownMenu, type DropdownItem } from '@components/Dropdown';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { OpenShareDialog } from '@components/Share/ShareDialog';
import { useLocale } from '@components/LocaleContext';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import { useStore } from '@tomic/react';
import { FilePickerDialog } from '@components/forms/FilePicker/FilePickerDialog';
import type { HostReply } from '@chunks/AppPage/hostStore';
import { AppFormDialog, AskedBy, PickResourceDialog } from './hostUIDialogs';
import {
  parseConfirm,
  parseForm,
  parseMenu,
  parsePickFile,
  parsePickResource,
  parsePoint,
  parseSubject,
  parseToast,
  placeInFrame,
  shouldForwardKey,
  type ConfirmAsk,
  type FormAsk,
  type MenuEntry,
  type PickResourceAsk,
  type Point,
} from './hostUIRequests';

/**
 * The host UI an app's view can ask for: a confirm, a toast, a menu at a
 * point, the resource menu, the share dialog, opening a resource, the
 * resource and file pickers, and a form for a new resource of a class.
 *
 * Drawn here rather than in the frame for two reasons. A frame cannot draw
 * outside its own box, so its menus would be cut off at the edge. And these
 * should be the host's own components, so an app looks like part of Atomic
 * instead of every app rebuilding them. Each one names the app that asked,
 * so an app cannot pass a prompt off as the host's.
 *
 * One question at a time per frame: a new ask answers the open one as
 * cancelled, the same rule `proxyConnect` follows.
 */
export function useHostUI({
  writeRoot,
  mayWriteUnder,
  appTitle,
  frame,
  table,
}: {
  /** Where uploads go, and a form's parent by default: the app, or the page. */
  writeRoot: string;
  /** Whether this view may write under `subject`, by its own write policy. */
  mayWriteUnder: (subject: string) => Promise<boolean>;
  /** The app or plugin's name, shown on everything it asks for. */
  appTitle: string;
  frame: React.RefObject<HTMLIFrameElement | null>;
  /** Set when the app is a view of a table, so it knows where it sits. */
  table?: string;
}): {
  /** Answers `request` if it is a UI ask; false when it is not one. */
  handle: (request: UIRequest, post: (reply: HostReply) => void) => boolean;
  /** Passes a key the frame did not handle to the host's shortcuts. */
  forwardKey: (message: unknown) => boolean;
  element: JSX.Element;
} {
  const [ask, setAsk] = useState<UIAsk>();
  const askRef = useRef<UIAsk | undefined>(undefined);
  const navigate = useNavigateWithTransition();
  const { openResourceMenu } = useResourceContextMenu();
  const { locale } = useLocale();
  const store = useStore();

  // Read through a ref: `handle` is captured once by the frame bridge, and
  // must still see the current title, locale and navigation.
  const latest = useRef({
    navigate,
    openResourceMenu,
    locale,
    appTitle,
    table,
    writeRoot,
    mayWriteUnder,
  });
  useEffect(() => {
    latest.current = {
      navigate,
      openResourceMenu,
      locale,
      appTitle,
      table,
      writeRoot,
      mayWriteUnder,
    };
  });

  const open = useCallback((next: UIAsk) => {
    const previous = askRef.current;
    previous?.reply({ id: previous.id, result: cancelledResult(previous) });
    askRef.current = next;
    setAsk(next);
  }, []);

  const finish = useCallback((done: UIAsk, result: unknown) => {
    if (askRef.current !== done) return;
    done.reply({ id: done.id, result });
    askRef.current = undefined;
    setAsk(undefined);
  }, []);

  const handle = useCallback(
    (request: UIRequest, post: (reply: HostReply) => void): boolean => {
      if (!UI_OPS.has(request.op)) return false;

      const now = latest.current;
      const reply = (result: unknown) => post({ id: request.id, result });

      try {
        switch (request.op) {
          case 'confirm':
            open({
              kind: 'confirm',
              id: request.id,
              reply: post,
              confirm: parseConfirm(request),
            });
            break;

          case 'toast': {
            const { text, kind } = parseToast(request);
            const message = `${now.appTitle}: ${text}`;

            if (kind === 'success') toast.success(message);
            else if (kind === 'error') toast.error(message);
            else toast(message);

            reply(true);
            break;
          }

          case 'menu': {
            const menu = parseMenu(request);
            open({
              kind: 'menu',
              id: request.id,
              reply: post,
              at: placeInFrame(menu.at, frameRect(frame)),
              items: menu.items,
            });
            break;
          }

          case 'resourceMenu': {
            const subject = parseSubject(request);
            const at = placeInFrame(parsePoint(request.at), frameRect(frame));
            now.openResourceMenu(subject, pointerAt(at));
            reply(true);
            break;
          }

          case 'share':
            open({
              kind: 'share',
              id: request.id,
              reply: post,
              subject: parseSubject(request),
            });
            break;

          case 'openResource':
            now.navigate(constructOpenURL(parseSubject(request)));
            reply(true);
            break;

          case 'pickResource':
            open({
              kind: 'pickResource',
              id: request.id,
              reply: post,
              pick: parsePickResource(request),
            });
            break;

          case 'pickFile':
            open({
              kind: 'pickFile',
              id: request.id,
              reply: post,
              accept: parsePickFile(request).accept,
              uploading: false,
            });
            break;

          case 'form': {
            const form = parseForm(request);
            const parent = form.parent ?? now.writeRoot;

            // Checked before anything is shown: the person sees the fields,
            // not where the result goes, so a view may only aim it where it
            // could write itself.
            void now.mayWriteUnder(parent).then(
              within => {
                if (!within) {
                  post({
                    id: request.id,
                    error:
                      /* @wc-ignore */ 'A form may only create resources where this view may write. Leave parent out to use its default.',
                  });

                  return;
                }

                open({
                  kind: 'form',
                  id: request.id,
                  reply: post,
                  form,
                  parent,
                });
              },
              (e: Error) => post({ id: request.id, error: e.message }),
            );
            break;
          }

          case 'environment':
            reply({
              locale: now.locale,
              placement: now.table ? 'tab' : 'page',
            });
            break;
        }
      } catch (e) {
        post({ id: request.id, error: (e as Error).message });
      }

      return true;
    },
    [open, frame],
  );

  /** A new file from disk, uploaded under the app, answers the ask. */
  const upload = useCallback(
    (picking: UIAsk & { kind: 'pickFile' }, file: File) => {
      const busy = { ...picking, uploading: true };
      askRef.current = busy;
      setAsk(busy);
      store.uploadFiles([file], latest.current.writeRoot).then(
        ([subject]) => finish(busy, subject ?? null),
        (e: Error) => {
          if (askRef.current !== busy) return;
          busy.reply({ id: busy.id, error: e.message });
          askRef.current = undefined;
          setAsk(undefined);
        },
      );
    },
    [store, finish],
  );

  const forwardKey = useCallback(
    (message: unknown): boolean => {
      if (!isViewKeyEvent(message)) return false;

      if (shouldForwardKey(message)) {
        // Dispatched on the frame element, so it bubbles to the document
        // listeners the host's shortcuts use, as if pressed on the frame.
        frame.current?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: message.key,
            code: message.code,
            ctrlKey: message.ctrlKey,
            metaKey: message.metaKey,
            shiftKey: message.shiftKey,
            altKey: message.altKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      return true;
    },
    [frame],
  );

  return {
    handle,
    forwardKey,
    element: (
      <>
        {ask?.kind === 'confirm' && (
          <ConfirmationDialog
            key={String(ask.id)}
            show
            title={ask.confirm.title}
            confirmLabel={ask.confirm.confirmLabel}
            theme={
              ask.confirm.danger
                ? ConfirmationDialogTheme.Alert
                : ConfirmationDialogTheme.Default
            }
            onConfirm={() => finish(ask, true)}
            onCancel={() => finish(ask, false)}
          >
            <AskedBy>Asked by {appTitle}</AskedBy>
            {ask.confirm.body && <p>{ask.confirm.body}</p>}
          </ConfirmationDialog>
        )}
        {ask?.kind === 'menu' && (
          <DropdownMenu
            key={String(ask.id)}
            Trigger={AutoOpenTrigger}
            anchorPoint={ask.at}
            searchable={false}
            items={menuItems(appTitle, ask.items, id => finish(ask, id))}
            bindActive={active => {
              // After a click, not before it: the item's own handler answers
              // with its id, and closing must not beat it to a `null`.
              if (!active) setTimeout(() => finish(ask, null));
            }}
          />
        )}
        {ask?.kind === 'pickResource' && (
          <PickResourceDialog
            key={String(ask.id)}
            appTitle={appTitle}
            ask={ask.pick}
            onPicked={subject => finish(ask, subject)}
            onClosed={() => setTimeout(() => finish(ask, null))}
          />
        )}
        {ask?.kind === 'pickFile' && !ask.uploading && (
          <FilePickerDialog
            key={String(ask.id)}
            show
            allowedMimes={ask.accept ? new Set(ask.accept) : undefined}
            note={<AskedBy>Asked by {appTitle}</AskedBy>}
            onResourcePicked={subject => finish(ask, subject)}
            onNewFilePicked={file => upload(ask, file)}
            onShowChange={show => {
              if (!show) setTimeout(() => finish(ask, null));
            }}
          />
        )}
        {ask?.kind === 'form' && (
          <AppFormDialog
            key={String(ask.id)}
            appTitle={appTitle}
            ask={ask.form}
            parent={ask.parent}
            onSaved={subject => finish(ask, subject)}
            onClosed={() => setTimeout(() => finish(ask, null))}
          />
        )}
        {ask?.kind === 'share' && (
          <OpenShareDialog
            key={String(ask.id)}
            subject={ask.subject}
            onClosed={() => finish(ask, true)}
          />
        )}
      </>
    ),
  };
}

/** The fields a UI ask may carry, spread from the request's `args`. */
export type UIRequest = {
  id: number | string;
  op: string;
} & Record<string, unknown>;

type UIAsk = {
  id: number | string;
  reply: (reply: HostReply) => void;
} & (
  | { kind: 'confirm'; confirm: ConfirmAsk }
  | { kind: 'menu'; at: Point; items: MenuEntry[] }
  | { kind: 'share'; subject: string }
  | { kind: 'pickResource'; pick: PickResourceAsk }
  | { kind: 'pickFile'; accept?: string[]; uploading: boolean }
  | { kind: 'form'; form: FormAsk; parent: string }
);

const UI_OPS = new Set([
  'confirm',
  'toast',
  'menu',
  'resourceMenu',
  'share',
  'openResource',
  'environment',
  'pickResource',
  'pickFile',
  'form',
]);

/** What an ask answers when a newer one replaces it. */
function cancelledResult(ask: UIAsk): unknown {
  if (ask.kind === 'confirm') return false;
  if (ask.kind === 'share') return true;

  return null;
}

function menuItems(
  appTitle: string,
  entries: MenuEntry[],
  choose: (id: string) => void,
): DropdownItem[] {
  return [
    // The app's name heads every menu it opens, so its items never read as
    // the host's own.
    {
      id: '__app',
      label: appTitle,
      header: true,
      disabled: true,
      onClick: () => undefined,
    },
    'divider',
    ...entries.map(
      (entry): DropdownItem =>
        entry === 'divider'
          ? 'divider'
          : {
              id: entry.id,
              label: entry.label,
              disabled: entry.disabled,
              onClick: () => choose(entry.id),
            },
    ),
  ];
}

function frameRect(frame: React.RefObject<HTMLIFrameElement | null>) {
  const rect = frame.current?.getBoundingClientRect();

  if (!rect) throw new Error('The app is not on screen');

  return rect;
}

/** `openResourceMenu` reads only the pointer position off its event. */
function pointerAt(point: Point): React.MouseEvent {
  return {
    clientX: point.x,
    clientY: point.y,
    preventDefault: () => undefined,
  } as React.MouseEvent;
}
