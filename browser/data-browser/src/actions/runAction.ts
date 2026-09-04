import toast from 'react-hot-toast';
import type { ActionContext, ActionDefinition } from './types';

/**
 * Run an action, and never let its failure disappear.
 *
 * `run` is async and most call sites invoke it without awaiting, so a rejection
 * used to become an unhandled promise — the menu closed, nothing happened, and
 * the only trace was in a console nobody had open. That is what a failed delete
 * looked like: the row stayed, and no error was ever shown.
 *
 * Actions that report their own failures still do; this is the net under them.
 */
export function runAction(action: ActionDefinition, ctx: ActionContext): void {
  try {
    const result = action.run(ctx) as unknown;

    if (result instanceof Promise) {
      void result.catch((e: unknown) => reportActionError(action, ctx, e));
    }
  } catch (e) {
    // A synchronous throw, before the promise even exists.
    reportActionError(action, ctx, e);
  }
}

export function reportActionError(
  action: ActionDefinition,
  ctx: ActionContext,
  e: unknown,
): void {
  const detail =
    e instanceof Error && e.message
      ? e.message
      : typeof e === 'string' && e
        ? e
        : 'unknown error';

  // `label` is `(ctx) => string`, not a string. Interpolating it directly put
  // the function's source in the toast — so the net added to surface a failed
  // action named it as `(ctx) => ...` instead of "Delete". Resolving it can
  // itself throw (it reads the resource), and a label that fails must not
  // swallow the error it was meant to report.
  let label = 'Action';

  try {
    label = action.label(ctx);
  } catch {
    // keep the fallback
  }

  // Logged as well as shown: the toast is necessarily short, and a server's
  // parse error is the kind of thing worth having in full.
  console.error(`[action] "${label}" failed:`, e);
  toast.error(`${label} failed: ${detail}`);
}
