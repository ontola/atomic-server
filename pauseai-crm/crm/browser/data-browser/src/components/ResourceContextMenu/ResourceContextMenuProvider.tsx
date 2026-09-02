import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PropsWithChildren,
} from 'react';
import { Client } from '@tomic/react';
import {
  ResourceContextMenuContext,
  ResourceContextMenuStateContext,
  type ResourceMenuState,
} from './ResourceContextMenuContext';

/**
 * Holds the app-level resource-context-menu state and exposes `openResourceMenu`
 * to the whole app. It does NOT render the menu itself — {@link
 * ResourceContextMenuHost} does, mounted deep enough to be inside every provider
 * the menu's actions need (AI sidebar, dialogs, router). Mount this provider
 * high (above the app shell) so every resource-bearing element can open a menu.
 */
export function ResourceContextMenuProvider({
  children,
}: PropsWithChildren): JSX.Element {
  const [state, setState] = useState<ResourceMenuState | undefined>();
  const openIdRef = useRef(0);

  const openResourceMenu = useCallback((subject: string, event: MouseEvent) => {
    if (!Client.isValidSubject(subject)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openIdRef.current += 1;
    setState({
      subject,
      point: { x: event.clientX, y: event.clientY },
      openId: openIdRef.current,
    });
  }, []);

  // Stable so the (many) trigger consumers never re-render when a menu opens.
  const triggerValue = useMemo(
    () => ({ openResourceMenu }),
    [openResourceMenu],
  );
  const stateValue = useMemo(() => ({ state }), [state]);

  return (
    <ResourceContextMenuContext value={triggerValue}>
      <ResourceContextMenuStateContext value={stateValue}>
        {children}
      </ResourceContextMenuStateContext>
    </ResourceContextMenuContext>
  );
}
