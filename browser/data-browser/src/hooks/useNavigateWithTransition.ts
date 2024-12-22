import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, type NavigateOptions, type To } from 'react-router';
import { useSettings } from '../helpers/AppSettings';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A wrapper around react-router's navigate function that will trigger css view transitions if enabled.
 */
export function useNavigateWithTransition() {
  const navigate = useNavigate();
  const { viewTransitionsDisabled } = useSettings();

  const navigateWithTransition = useCallback(
    (to: To, options?: NavigateOptions) => {
      const doNavigate = (transition?: boolean) => {
        const newOptions: NavigateOptions = {
          ...options,
        };

        if (typeof to !== 'number') {
          navigate(to, newOptions);
        } else {
          navigate(to);
        }
      };

      if (viewTransitionsDisabled || !document.startViewTransition) {
        doNavigate(false);

        return;
      }

      console.log('doNavigate', true);
      document.startViewTransition(
        async () =>
          new Promise<void>(resolve => {
            flushSync(() => {
              doNavigate(true);
            });
            wait(1).then(() => {
              resolve();
            });
          }),
      );
    },
    [navigate],
  );

  return navigateWithTransition;
}
