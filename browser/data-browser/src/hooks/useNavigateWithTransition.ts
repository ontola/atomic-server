import { useSettings } from '../helpers/AppSettings';
import { wrapWithViewTransition } from '../helpers/viewTransition';
import { useNavigate, useRouter } from '@tanstack/react-router';

/**
 * A wrapper around tanstack-router's navigate function that will trigger css view transitions if enabled.
 */
export function useNavigateWithTransition() {
  const navigate = useNavigate();
  const { viewTransitionsEnabled } = useSettings();

  const navigateWithTransition = wrapWithViewTransition(
    !viewTransitionsEnabled,
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
  const { viewTransitionsEnabled } = useSettings();

  const back = wrapWithViewTransition(
    !viewTransitionsEnabled,
    () =>
      new Promise(resolve => {
        router.history.back();
        setTimeout(() => resolve(), 10);
      }),
  );

  const forward = wrapWithViewTransition(
    !viewTransitionsEnabled,
    () =>
      new Promise(resolve => {
        router.history.forward();
        setTimeout(() => resolve(), 10);
      }),
  );

  return { back, forward };
}
