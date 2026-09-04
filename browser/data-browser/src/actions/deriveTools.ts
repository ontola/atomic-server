import { tool } from 'ai';
import { z } from 'zod';
import type { ActionContext, ActionDefinition } from './types';

export interface DeriveActionToolsOptions {
  /**
   * Build a real ActionContext for the target subject. Called once per
   * tool invocation, after the subject is known.
   */
  buildContext: (subject: string) => Promise<ActionContext>;
  /** Expand `#ref` / compact subjects before loading. */
  expandSubject?: (subject: string) => string;
}

export async function executeDerivedAction(
  action: ActionDefinition,
  subjectOrRef: string,
  options: DeriveActionToolsOptions,
): Promise<
  | string
  | {
      success: boolean;
      message: string;
      action?: string;
      subject?: string;
    }
> {
  const expand = options.expandSubject ?? ((subject: string) => subject);
  const subject = expand(subjectOrRef);

  try {
    const ctx = await options.buildContext(subject);

    if (action.available && !action.available(ctx)) {
      return {
        success: false,
        message: `Cannot ${action.label(ctx)} this resource.`,
      };
    }

    await action.run(ctx);

    return {
      success: true,
      action: action.id,
      subject,
      message: `${action.label(ctx)} succeeded.`,
    };
  } catch (error) {
    return `Error running ${action.toolName ?? action.id} on ${subject}: ${error}`;
  }
}

/**
 * Turn `asTool` action definitions into AI SDK tools. Rich tools (query,
 * create_table, …) stay bespoke in `useAtomicTools`; this is only the
 * simple verbs whose `run` is the whole implementation.
 */
export function deriveActionTools(
  actions: ActionDefinition[],
  options: DeriveActionToolsOptions,
) {
  const tools: Record<string, unknown> = {};

  for (const action of actions) {
    if (!action.asTool) {
      continue;
    }

    const name = action.toolName ?? action.id;
    let description = action.id;

    try {
      description = action.helper({} as ActionContext);
    } catch {
      // keep the id fallback
    }

    tools[name] = tool({
      description,
      inputSchema: z.object({
        subject: z
          .string()
          .describe('The subject (URL or #ref) of the resource'),
      }),
      execute: async ({ subject }: { subject: string }) =>
        executeDerivedAction(action, subject, options),
      strict: true,
    });
  }

  return tools as Record<string, ReturnType<typeof tool>>;
}

export function actionToolNames(actions: ActionDefinition[]): string[] {
  return actions
    .filter(action => action.asTool)
    .map(action => action.toolName ?? action.id);
}
