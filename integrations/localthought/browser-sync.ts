// @wc-ignore-file
import type {
  ConnectionState,
  ExternalIntent,
  ExternalReceipt,
} from '../../browser/lib/src/plugin-connection';

export interface SyncSession {
  binding?: string;
  proposal: unknown;
  connection: ConnectionState;
  cursor?: unknown;
  result?: unknown;
  pending?: { kind: string; id: string };
  complete?: boolean;
}
export type Step =
  | { kind: 'complete' }
  | { kind: 'continue'; cursor: unknown }
  | {
      kind: 'effect';
      cursor: unknown;
      effect:
        | { kind: 'external'; id: string; request: ExternalIntent }
        | { kind: 'atomic'; id: string; verdict: unknown }
        | {
            kind: 'checkpoint';
            id: string;
            records: Array<{
              remote: string;
              local: string;
              local_projection: Record<string, unknown> | null;
              remote_projection: Record<string, unknown> | null;
            }>;
          };
    };

/** Must be called under the installation's Web Lock, only after review.
 * Persist before dispatch: an interrupted effect is never automatically replayed.
 * This conservatively blocks uncertain local writes as well as remote creates.
 */
export async function continueBrowserSync(
  initial: SyncSession,
  host: {
    step(session: SyncSession): Promise<Step>;
    save(session: SyncSession): void;
    external(intent: ExternalIntent): Promise<ExternalReceipt>;
    atomic(verdict: unknown): Promise<unknown>;
  },
  limit = 2000,
): Promise<SyncSession> {
  let session = structuredClone(initial);
  if (session.pending)
    throw new Error(
      'A previous effect has an uncertain result. Reconcile it before continuing.',
    );
  if (session.complete) return session;
  for (let i = 0; i < limit; i++) {
    const step = await host.step(session);
    if (step.kind === 'complete') {
      session.complete = true;
      host.save(session);
      return session;
    }
    if (step.kind === 'continue') {
      session.cursor = step.cursor;
      delete session.result;
      host.save(session);
      continue;
    }
    const effect = step.effect;
    if (effect.kind === 'checkpoint') {
      const records = { ...session.connection.records };
      const seen = new Set<string>();
      for (const record of effect.records) {
        if (
          !record.remote ||
          !record.local ||
          seen.has(record.remote) ||
          JSON.stringify(record.local_projection) !==
            JSON.stringify(record.remote_projection)
        )
          throw new Error('Checkpoint requires distinct, converged records');
        seen.add(record.remote);
        records[record.remote] = {
          local: record.local,
          baseline: record.local_projection,
        };
      }
      session.connection = {
        ...session.connection,
        revision: session.connection.revision + 1,
        records,
      };
      delete session.result;
    } else {
      session.pending = { kind: effect.kind, id: effect.id };
      host.save(session);
      session.result =
        effect.kind === 'external'
          ? await host.external(effect.request)
          : await host.atomic(effect.verdict);
      delete session.pending;
    }
    session.cursor = step.cursor;
    host.save(session);
  }
  throw new Error('Sync reached its step limit; continue the saved run');
}
