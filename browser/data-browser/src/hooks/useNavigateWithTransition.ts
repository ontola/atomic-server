import { flushSync } from 'react-dom';
import { useSettings } from '../helpers/AppSettings';
import { useNavigate, useRouter } from '@tanstack/react-router';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithTransition<F extends (...args: any[]) => Promise<void>>(
  disabled: boolean,
  cb: F,
) {
  if (disabled || !document.startViewTransition) {
    return cb;
  }

  return (...args: Parameters<F>) =>
    document.startViewTransition(() => {
      return new Promise<void>(resolve => {
        flushSync(() => {
          cb(...args).then(() => resolve());
        });
      });
    }).updateCallbackDone as Promise<void>;
}

/**
 * A wrapper around tanstack-router's navigate function that will trigger css view transitions if enabled.
 */
export function useNavigateWithTransition() {
  const navigate = useNavigate();
  const { viewTransitionsDisabled } = useSettings();

  const navigateWithTransition = wrapWithTransition(
    viewTransitionsDisabled,
    (options: Parameters<typeof navigate>[0] | string) => {
      const newOptions =
        typeof options === 'string'
          ? ({
              to: options,
            } satisfies Parameters<typeof navigate>[0])
          : options;

      return navigate(newOptions);
    },
  );

  return navigateWithTransition;
}

export function useBackForward() {
  const router = useRouter();
  const { viewTransitionsDisabled } = useSettings();

  const back = wrapWithTransition(
    viewTransitionsDisabled,
    () =>
      new Promise(resolve => {
        router.history.back();
        setTimeout(() => resolve(), 10);
      }),
  );

  const forward = wrapWithTransition(
    viewTransitionsDisabled,
    () =>
      new Promise(resolve => {
        router.history.forward();
        setTimeout(() => resolve(), 10);
      }),
  );

  return { back, forward };
}
