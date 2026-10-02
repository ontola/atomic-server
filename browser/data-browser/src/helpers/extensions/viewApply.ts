// @wc-ignore-file
import {
  applyPlan,
  parseVerdict,
  planHostFromStore,
  planVerdict,
  type ApplyHost,
  type ApplyReport,
  type Intent,
  type PlannedChange,
  type RunPlan,
  type Store,
} from '@tomic/react';

/**
 * `store.apply(intents)`: several writes a view makes as one change.
 *
 * The intents are the ones a plugin's `run()` returns, so a view and a run
 * speak one vocabulary. Everything is planned before anything is written: the
 * values are checked against their properties and every write against the
 * view's own rules, so a mistake in the fifth write stops all five. A write
 * that still fails rolls back the ones before it, and the view can undo the
 * whole change later as one step.
 */

/** More than a form edit needs, few enough to plan in one go. */
export const MAX_VIEW_INTENTS = 200;
/** Changes a view can undo, newest first. */
const UNDO_DEPTH = 20;

export interface ViewApplyHost {
  /** Writes as this view: the person for a packaged view, the app's key for an app. */
  writes: ApplyHost;
  /** Throws when this view may not write `subject` (asking the person first, where the host does). */
  authorize: (subject: string) => Promise<void>;
}

export interface ViewApplyResult {
  /** `localId` to the subject its create got. */
  subjects: Record<string, string>;
}

/** What undoing one change needs: how to put it back, and what it left. */
interface UndoEntry {
  inverse: Inverse[];
}

type Inverse =
  | {
      op: 'destroy';
      subject: string;
      /** What the create wrote, so undo leaves a resource others filled in. */
      left: Record<string, unknown>;
    }
  | {
      op: 'restore';
      subject: string;
      /** Values to put back. */
      set: Record<string, unknown>;
      /** Properties the change added, to take away again. */
      remove: string[];
      /** What the change left, so undo can tell if someone changed it since. */
      left: Record<string, unknown>;
    };

/** One frame's applied changes, so `undo` reverts the latest. */
export class ViewChanges {
  private undoStack: UndoEntry[] = [];

  public constructor(
    private readonly store: Store,
    private readonly host: ViewApplyHost,
  ) {}

  public async apply(raw: unknown): Promise<ViewApplyResult> {
    if (!Array.isArray(raw)) throw new Error('intents must be a list');

    if (raw.length === 0) return { subjects: {} };

    if (raw.length > MAX_VIEW_INTENTS)
      throw new Error(`at most ${MAX_VIEW_INTENTS} intents in one apply`);

    const verdict = parseVerdict(
      { intents: raw, problems: [] },
      { maxIntents: MAX_VIEW_INTENTS },
    );
    const plan = await planVerdict(verdict, planHostFromStore(this.store));
    refuseBlocked(plan);

    await this.authorizeAll(plan);

    // Destroys go last: they are the one write a rollback cannot take back,
    // so they only run once everything else has landed.
    const [rest, destroys] = splitDestroys(plan);
    const report = await applyPlan(rest, this.host.writes, {
      concurrency: 1,
    });

    if (report.failed > 0) {
      const undone = await this.revert(inverseOf(rest, report), false);
      throw new Error(
        `${firstFailure(report)}. ${undone.ok ? 'Nothing was changed' : `Rolling back failed too: ${undone.error}`}.`,
      );
    }

    const destroyed =
      destroys.changes.length > 0
        ? await applyPlan(destroys, this.host.writes, { concurrency: 1 })
        : undefined;

    if (destroyed && destroyed.failed > 0) {
      throw new Error(
        `${firstFailure(destroyed)}. The other changes were made; ${destroyed.applied} of ${destroys.changes.length} deletions too.`,
      );
    }

    // A change that deleted something cannot be undone: the resource and its
    // history are gone, not just its values.
    if (destroys.changes.length === 0) {
      this.undoStack.push({ inverse: inverseOf(rest, report) });
      this.undoStack.splice(0, this.undoStack.length - UNDO_DEPTH);
    } else {
      this.undoStack = [];
    }

    return { subjects: localSubjects(plan, report) };
  }

  /**
   * Reverts this view's latest change. False when there is nothing to undo.
   * Refuses, changing nothing, when someone changed those values since.
   */
  public async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();

    if (!entry) return false;

    const result = await this.revert(entry.inverse, true);

    if (!result.ok) {
      if (result.untouched) this.undoStack.push(entry);
      throw new Error(result.error);
    }

    return true;
  }

  private async authorizeAll(plan: RunPlan): Promise<void> {
    const planned = new Set(
      plan.changes.filter(c => c.op === 'create').map(c => c.subject),
    );
    const targets = new Set<string>();

    for (const change of plan.changes) {
      const target = change.op === 'create' ? change.parent! : change.subject;

      // Something this change creates is the view's own to write.
      if (!planned.has(target)) targets.add(target);
    }

    // One at a time: a host may ask the person, and two prompts at once
    // would answer each other.
    for (const target of targets) await this.host.authorize(target);
  }

  private async revert(
    inverse: Inverse[],
    checkUnchanged: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string; untouched: boolean }> {
    if (checkUnchanged) {
      for (const step of inverse) {
        const now = (await this.store.getResource(step.subject)).getPropVals();

        for (const [property, value] of Object.entries(step.left)) {
          if (!sameValue(now[property], value))
            return {
              ok: false,
              untouched: true,
              error: 'This was changed since, so it was not undone',
            };
        }
      }
    }

    let done = 0;

    try {
      for (const step of [...inverse].reverse()) {
        await this.host.authorize(step.subject);

        if (step.op === 'destroy') {
          await this.host.writes.destroy(step.subject);
        } else {
          if (step.remove.length)
            await this.host.writes.remove(step.subject, step.remove);

          if (Object.keys(step.set).length)
            await this.host.writes.set(step.subject, step.set as never);
        }

        done++;
      }
    } catch (e) {
      return {
        ok: false,
        untouched: done === 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    return { ok: true };
  }
}

function refuseBlocked(plan: RunPlan): void {
  // A malformed intent is dropped and reported, not planned: for a view that
  // is a refusal too, or the rest would apply without it.
  const errors = [
    ...plan.problems,
    ...plan.changes.flatMap(c => c.problems),
  ].filter(p => p.severity === 'error');

  if (!plan.blocked && errors.length === 0) return;

  const messages = errors
    .slice(0, 5)
    .map(p => (p.subject ? `${p.subject}: ${p.message}` : p.message));

  throw new Error(`Nothing was changed: ${messages.join('; ')}`);
}

function splitDestroys(plan: RunPlan): [RunPlan, RunPlan] {
  const keep = (destroy: boolean) => ({
    ...plan,
    changes: plan.changes.filter(c => (c.op === 'destroy') === destroy),
  });

  return [keep(false), keep(true)];
}

/** How to put back what `report` says was applied, in the order it was. */
function inverseOf(plan: RunPlan, report: ApplyReport): Inverse[] {
  const changes = new Map(
    plan.changes.map(c => [c.subject, [] as PlannedChange[]]),
  );
  plan.changes.forEach(c => changes.get(c.subject)!.push(c));
  const seen = new Map<string, number>();

  return report.outcomes.flatMap((outcome): Inverse[] => {
    if (outcome.status !== 'applied') return [];

    // Outcomes come per change, in order per subject.
    const index = seen.get(outcome.planned) ?? 0;
    seen.set(outcome.planned, index + 1);
    const change = changes.get(outcome.planned)?.[index];

    if (!change) return [];

    if (change.op === 'create')
      return [
        {
          op: 'destroy',
          subject: outcome.subject,
          left: Object.fromEntries(
            change.properties.map(p => [p.property, rewriteRefs(p.to, report)]),
          ),
        },
      ];

    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    const left: Record<string, unknown> = {};

    for (const p of change.properties) {
      if (p.from === undefined) remove.push(p.property);
      else set[p.property] = p.from;

      if (change.op === 'set') left[p.property] = rewriteRefs(p.to, report);
      else left[p.property] = undefined;
    }

    return [{ op: 'restore', subject: outcome.subject, set, remove, left }];
  });
}

/** A value as it was written: planned subjects replaced by the real ones. */
function rewriteRefs(value: unknown, report: ApplyReport): unknown {
  if (typeof value === 'string') return report.subjects[value] ?? value;
  if (Array.isArray(value)) return value.map(v => rewriteRefs(v, report));

  return value;
}

function localSubjects(
  plan: RunPlan,
  report: ApplyReport,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(plan.minted).map(([localId, planned]) => [
      localId,
      report.subjects[planned] ?? planned,
    ]),
  );
}

function firstFailure(report: ApplyReport): string {
  const failed = report.outcomes.find(o => o.status === 'failed');

  return failed
    ? `Could not ${failed.op} ${failed.planned}: ${failed.error ?? 'failed'}`
    : 'A write failed';
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export type { Intent };
