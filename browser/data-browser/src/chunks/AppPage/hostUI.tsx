import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';
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
import type { HostReply } from './hostStore';
import {
  parseConfirm,
  parseMenu,
  parsePoint,
  parseSubject,
  parseToast,
  placeInFrame,
  shouldForwardKey,
  type ConfirmAsk,
  type MenuEntry,
  type Point,
} from './hostUIRequests';

/**
 * The host UI an app's view can ask for: a confirm, a toast, a menu at a
 * point, the resource menu, the share dialog, opening a resource.
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
  appTitle,
  frame,
  table,
}: {
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

  // Read through a ref: `handle` is captured once by the frame bridge, and
  // must still see the current title, locale and navigation.
  const latest = useRef({
    navigate,
    openResourceMenu,
    locale,
    appTitle,
    table,
  });
  useEffect(() => {
    latest.current = { navigate, openResourceMenu, locale, appTitle, table };
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
);

const UI_OPS = new Set([
  'confirm',
  'toast',
  'menu',
  'resourceMenu',
  'share',
  'openResource',
  'environment',
]);

/** What an ask answers when a newer one replaces it. */
function cancelledResult(ask: UIAsk): unknown {
  if (ask.kind === 'confirm') return false;
  if (ask.kind === 'menu') return null;

  return true;
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

const AskedBy = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  margin-top: 0;
`;
