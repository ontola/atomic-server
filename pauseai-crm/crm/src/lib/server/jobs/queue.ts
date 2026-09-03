// A small Postgres-backed job queue. One table, `for update skip locked`,
// exponential backoff. Deliberately not a library: the whole thing is under
// 150 lines, has no extra infrastructure, and runs fine on the smallest host.
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { jobs, type Job } from '../db/schema'

export type JobHandler = (payload: Record<string, unknown>, job: Job, db: Db) => Promise<void>

const handlers = new Map<string, JobHandler>()

export function registerJob(kind: string, handler: JobHandler) {
	handlers.set(kind, handler)
}

export function registeredJobKinds(): string[] {
	return [...handlers.keys()]
}

export type EnqueueOptions = {
	runAt?: Date
	/** While a job with this key is queued or running, a second enqueue is dropped. */
	dedupeKey?: string
	maxAttempts?: number
}

export async function enqueue(
	kind: string,
	payload: Record<string, unknown> = {},
	options: EnqueueOptions = {},
	db: Db = sharedDb()
): Promise<Job | undefined> {
	const [row] = await db
		.insert(jobs)
		.values({
			kind,
			payload,
			runAt: options.runAt ?? new Date(),
			dedupeKey: options.dedupeKey ?? null,
			maxAttempts: options.maxAttempts ?? 5
		})
		.onConflictDoNothing({
			target: jobs.dedupeKey,
			where: sql`${jobs.status} in ('queued', 'running')`
		})
		.returning()
	return row
}

/** Claim the next runnable job, if any. Safe to call from many workers at once. */
export async function claimNext(workerId: string, db: Db = sharedDb()): Promise<Job | undefined> {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.status, 'queued'), lte(jobs.runAt, new Date())))
			.orderBy(asc(jobs.runAt))
			.limit(1)
			.for('update', { skipLocked: true })
		if (!candidate) return undefined
		const [claimed] = await tx
			.update(jobs)
			.set({ status: 'running', lockedAt: new Date(), lockedBy: workerId, attempts: sql`${jobs.attempts} + 1` })
			.where(eq(jobs.id, candidate.id))
			.returning()
		return claimed
	})
}

export function backoffSeconds(attempt: number): number {
	// 30s, 2m, 8m, 32m, ~2h — enough to ride out an Airtable or Discord outage.
	return Math.min(30 * 4 ** (attempt - 1), 6 * 3600)
}

/** Run one claimed job to completion, recording the outcome. Returns true when a job ran. */
export async function runOne(workerId: string, db: Db = sharedDb()): Promise<boolean> {
	const job = await claimNext(workerId, db)
	if (!job) return false
	const handler = handlers.get(job.kind)
	try {
		if (!handler) throw new Error(`No handler registered for job kind "${job.kind}"`)
		await handler(job.payload, job, db)
		await db
			.update(jobs)
			.set({ status: 'done', finishedAt: new Date(), lockedAt: null, lockedBy: null })
			.where(eq(jobs.id, job.id))
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		const exhausted = job.attempts >= job.maxAttempts
		await db
			.update(jobs)
			.set({
				status: exhausted ? 'dead' : 'queued',
				lastError: message.slice(0, 4000),
				lockedAt: null,
				lockedBy: null,
				runAt: exhausted ? job.runAt : new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
				finishedAt: exhausted ? new Date() : null
			})
			.where(eq(jobs.id, job.id))
		console.error(`[jobs] ${job.kind} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${message}`)
	}
	return true
}

/** Jobs that were claimed but whose worker died. Re-queue them after a grace period. */
export async function releaseStale(olderThanMs = 15 * 60 * 1000, db: Db = sharedDb()) {
	const cutoff = new Date(Date.now() - olderThanMs)
	await db
		.update(jobs)
		.set({ status: 'queued', lockedAt: null, lockedBy: null })
		.where(and(eq(jobs.status, 'running'), lte(jobs.lockedAt, cutoff)))
}

/** Worker loop. Polls with a short sleep when idle; returns when `signal` aborts. */
export async function workLoop(
	options: { workerId?: string; idleMs?: number; signal?: AbortSignal } = {},
	db: Db = sharedDb()
) {
	const workerId = options.workerId ?? `worker-${process.pid}`
	const idleMs = options.idleMs ?? 2000
	while (!options.signal?.aborted) {
		const ran = await runOne(workerId, db)
		if (!ran) await new Promise((r) => setTimeout(r, idleMs))
	}
}
