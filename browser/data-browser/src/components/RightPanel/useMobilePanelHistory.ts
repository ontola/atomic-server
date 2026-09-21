import { useEffect, useEffectEvent, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';

/** Full-screen chat is a navigation layer: Back dismisses it on the same page. */
export function useMobilePanelHistory(open: boolean, onClose: () => void) {
  const { history } = useRouter();
  const entry = useRef<string | undefined>(undefined);
  const close = useEffectEvent(onClose);

  useEffect(
    () =>
      history.subscribe(({ location }) => {
        if (entry.current && location.state.mobileAIChat !== entry.current) {
          entry.current = undefined;
          close();
        }
      }),
    [history],
  );

  useEffect(() => {
    if (open && !entry.current) {
      entry.current = crypto.randomUUID();
      history.push(history.location.href, {
        ...history.location.state,
        mobileAIChat: entry.current,
      });
    } else if (!open && entry.current) {
      const ownsEntry = history.location.state.mobileAIChat === entry.current;
      entry.current = undefined;
      if (ownsEntry) history.back();
    }
  }, [open, history]);
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    mobileAIChat?: string;
  }
}
