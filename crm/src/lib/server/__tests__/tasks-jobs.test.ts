import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useTestDb } from '../../../test/db'
import { createChapter, ensureGlobalChapter } from '../chapters'
import { accessGrants, jobs, projectTemplates, tasks } from '../db/schema'
import { sandboxOutbox } from '../integrations/mailersend/send'
import { backoffSeconds, enqueue, registerJob, runOne } from '../jobs/queue'
import { upsertPerson } from '../people'
import { ancestorPaths, completeTask, deadlineSweep, dueDateFor, instantiateTemplate, tasksFor } from '../tasks'
import { BUILT_IN_TEMPLATES } from '../tasks/templates'

const db = useTestDb()
const DAY = 86_400_000

beforeEach(() => {
	sandboxOutbox.length = 0
})

describe('task templates', () => {
	it('instantiates a template with deadlines relative to the event date', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id }, db())
		const owner = (await upsertPerson({ email: 'owner@example.org', fullName: 'Owner' }, undefined, db())).person
		await db().insert(projectTemplates).values(BUILT_IN_TEMPLATES)
		const eventDay = new Date('2026-10-20T18:30:00Z')
		const { project, tasks: created } = await instantiateTemplate({ templateSlug: 'watch-party-and-emails', chapterId: uk.id, ownerPersonId: owner.id, dueAt: eventDay }, db())
		expect(project.dueAt.toISOString()).toBe(eventDay.toISOString())
		expect(created).toHaveLength(10)
		const venue = created.find((t) => t.templateStepKey === 'venue')!
		expect(venue.dueAt!.getTime()).toBe(eventDay.getTime() - 18 * DAY)
		expect(venue.ownerPersonId).toBe(owner.id)
		const mine = await tasksFor(owner.id, db())
		expect(mine[0]!.templateStepKey).toBe('venue')
		expect(dueDateFor({ key: 'k', title: 't', dueOffsetDays: 3, dueRelativeTo: 'start' }, new Date(0), new Date(10 * DAY)).getTime()).toBe(3 * DAY)
	})

	it('reminds before the deadline and escalates when nothing happens after it', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id }, db())
		const lead = (await upsertPerson({ email: 'lead@example.org', fullName: 'Lead' }, undefined, db())).person
		const vol = (await upsertPerson({ email: 'vol@example.org', fullName: 'Vol' }, undefined, db())).person
		await db().insert(accessGrants).values({ personId: lead.id, role: 'chapter_admin', chapterId: uk.id })
		const due = new Date('2026-09-10T12:00:00Z')
		const [task] = await db().insert(tasks).values({ title: 'Book venue', ownerPersonId: vol.id, chapterId: uk.id, dueAt: due }).returning()

		// Well before the deadline: nothing happens.
		expect(await deadlineSweep({ now: new Date('2026-09-01T12:00:00Z') }, db())).toEqual({ reminded: [], escalated: [] })
		// Two days before: reminder goes out once.
		const r1 = await deadlineSweep({ now: new Date('2026-09-08T13:00:00Z') }, db())
		expect(r1.reminded).toEqual([task!.id])
		expect(sandboxOutbox.at(-1)?.to[0]?.email).toBe('vol@example.org')
		expect((await deadlineSweep({ now: new Date('2026-09-09T13:00:00Z') }, db())).reminded).toEqual([])
		// One day overdue: still within grace.
		expect((await deadlineSweep({ now: new Date('2026-09-11T13:00:00Z') }, db())).escalated).toEqual([])
		// Three days overdue, no update since the reminder: escalate to the chapter admin.
		const r2 = await deadlineSweep({ now: new Date('2026-09-13T13:00:00Z') }, db())
		expect(r2.escalated).toEqual([task!.id])
		const after = await db().query.tasks.findFirst({ where: eq(tasks.id, task!.id) })
		expect(after?.ownerPersonId).toBe(lead.id)
		expect(after?.status).toBe('escalated')
		expect(after?.escalationLevel).toBe(1)
		expect(sandboxOutbox.at(-1)?.to.map((t) => t.email).sort()).toEqual(['lead@example.org', 'vol@example.org'])

		// The new owner completes it.
		const done = await completeTask(task!.id, lead.id, db())
		expect(done?.status).toBe('done')
		expect(ancestorPaths('/global/uk/bristol')).toEqual(['/global', '/global/uk', '/global/uk/bristol'])
	})

	it('does not escalate a task whose owner responded after the reminder', async () => {
		const vol = (await upsertPerson({ email: 'vol2@example.org', fullName: 'Vol' }, undefined, db())).person
		const [task] = await db().insert(tasks).values({ title: 'Thing', ownerPersonId: vol.id, dueAt: new Date('2026-09-10T12:00:00Z') }).returning()
		await deadlineSweep({ now: new Date('2026-09-09T12:00:00Z') }, db())
		await db().update(tasks).set({ status: 'in_progress', updatedAt: new Date('2026-09-11T12:00:00Z') }).where(eq(tasks.id, task!.id))
		expect((await deadlineSweep({ now: new Date('2026-09-15T12:00:00Z') }, db())).escalated).toEqual([])
	})
})

describe('job queue', () => {
	it('runs jobs, retries with backoff, dedupes and gives up after maxAttempts', async () => {
		const seen: string[] = []
		registerJob('test.ok', async (payload) => {
			seen.push(String(payload.n))
		})
		registerJob('test.fail', async () => {
			throw new Error('nope')
		})
		await enqueue('test.ok', { n: 1 }, {}, db())
		await enqueue('test.ok', { n: 2 }, { dedupeKey: 'k' }, db())
		await enqueue('test.ok', { n: 3 }, { dedupeKey: 'k' }, db())
		expect(await runOne('w', db())).toBe(true)
		expect(await runOne('w', db())).toBe(true)
		expect(await runOne('w', db())).toBe(false)
		expect(seen).toEqual(['1', '2'])

		const failing = await enqueue('test.fail', {}, { maxAttempts: 2 }, db())
		expect(await runOne('w', db())).toBe(true)
		let row = await db().query.jobs.findFirst({ where: eq(jobs.id, failing!.id) })
		expect(row?.status).toBe('queued')
		expect(row?.attempts).toBe(1)
		expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000)
		await db().update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, failing!.id))
		expect(await runOne('w', db())).toBe(true)
		row = await db().query.jobs.findFirst({ where: eq(jobs.id, failing!.id) })
		expect(row?.status).toBe('dead')
		expect(row?.lastError).toMatch(/nope/)
		expect(backoffSeconds(1)).toBe(30)
		expect(backoffSeconds(3)).toBe(480)
	})
})
