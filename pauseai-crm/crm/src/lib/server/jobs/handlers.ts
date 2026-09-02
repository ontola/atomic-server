// Job kinds and the recurring schedule. Import this module once (worker and
// server) so handlers are registered before anything enqueues.
import { deadlineSweep } from '../tasks'
import { runAirtableSync } from '../sync/airtable'
import { enqueue, registerJob } from './queue'
import type { Db } from '../db/client'

export const JOB = {
	airtableSync: 'airtable.sync',
	deadlineSweep: 'tasks.deadline_sweep'
} as const

registerJob(JOB.airtableSync, async (payload, _job, db) => {
	const report = await runAirtableSync({ full: payload.full === true }, db)
	console.info(`[jobs] airtable sync: members ${report.members.created}+${report.members.updated} (${report.members.errors.length} errors), chapters ${report.chapters.created}+${report.chapters.updated}`)
})

registerJob(JOB.deadlineSweep, async (_payload, _job, db) => {
	const result = await deadlineSweep({}, db)
	console.info(`[jobs] deadline sweep: reminded ${result.reminded.length}, escalated ${result.escalated.length}`)
})

/**
 * Recurring schedule. Called by the worker on start and every `tick`; the
 * dedupe keys make it safe to call from several processes.
 */
export async function scheduleRecurring(now = new Date(), db?: Db) {
	const hour = now.toISOString().slice(0, 13)
	await enqueue(JOB.airtableSync, {}, { dedupeKey: `${JOB.airtableSync}:${hour}` }, db)
	await enqueue(JOB.deadlineSweep, {}, { dedupeKey: `${JOB.deadlineSweep}:${hour}` }, db)
}
