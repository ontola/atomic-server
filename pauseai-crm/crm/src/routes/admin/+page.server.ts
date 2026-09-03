import { desc } from 'drizzle-orm'
import type { Actions, PageServerLoad } from './$types'
import { requireGlobalAdmin } from '$server/authz/guard'
import { db } from '$server/db/client'
import { jobs, syncSources, webhookEvents } from '$server/db/schema'
import { JOB } from '$server/jobs/handlers'
import { enqueue } from '$server/jobs/queue'
import { sandboxOutbox } from '$server/integrations/mailersend/send'

export const load: PageServerLoad = async ({ locals }) => {
	requireGlobalAdmin(locals.actor)
	const [sources, recentJobs, recentEvents] = await Promise.all([
		db().select().from(syncSources),
		db().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(20),
		db().select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(20)
	])
	return {
		sources: sources.map((s) => ({ source: s.source, lastRunAt: s.lastRunAt?.toISOString() ?? null, lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null, lastError: s.lastError, stats: s.stats })),
		jobs: recentJobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, runAt: j.runAt.toISOString(), lastError: j.lastError })),
		events: recentEvents.map((e) => ({ id: e.id, source: e.source, externalId: e.externalId, receivedAt: e.receivedAt.toISOString(), processedAt: e.processedAt?.toISOString() ?? null, error: e.error, type: String((e.payload as { type?: string }).type ?? '') })),
		outbox: sandboxOutbox.slice(-20).reverse().map((m) => ({ to: m.to.map((t) => t.email).join(', '), subject: m.subject, at: m.at.toISOString() }))
	}
}

export const actions: Actions = {
	sync: async ({ locals }) => {
		requireGlobalAdmin(locals.actor)
		await enqueue(JOB.airtableSync, { full: false }, { dedupeKey: `${JOB.airtableSync}:manual` })
		return { queued: true }
	}
}
