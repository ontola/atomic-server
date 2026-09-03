// Tasks and project templates: the "hold volunteers' hands through every small
// step" part of the brief. A template is a list of steps with relative
// deadlines; instantiating it for a chapter yields concrete tasks with owners
// and due dates. A scheduled job reminds owners before a deadline and
// escalates a task up the chain when it is missed and nobody responded.
import { and, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { accessGrants, chapters, memberships, people, projectTemplates, projects, tasks, teamMembers, type ProjectTemplate, type Task, type TaskTemplateStep } from '../db/schema'
import { logInteraction } from '../people'
import { sendEmail } from '../integrations/mailersend/send'
import { env } from '../env'

const DAY = 24 * 3600 * 1000

export function dueDateFor(step: TaskTemplateStep, startsAt: Date, dueAt: Date): Date {
	const base = step.dueRelativeTo === 'start' ? startsAt : dueAt
	return new Date(base.getTime() + step.dueOffsetDays * DAY)
}

export type InstantiateInput = {
	templateSlug: string
	chapterId: string
	name?: string
	ownerPersonId: string
	teamId?: string | null
	startsAt?: Date
	dueAt?: Date
	assignedBy?: string | null
}

/** Create a project and its tasks from a template. */
export async function instantiateTemplate(input: InstantiateInput, db: Db = sharedDb()) {
	const template = await db.query.projectTemplates.findFirst({ where: and(eq(projectTemplates.slug, input.templateSlug), eq(projectTemplates.active, true)) })
	if (!template) throw new Error(`Unknown project template "${input.templateSlug}"`)
	const startsAt = input.startsAt ?? new Date()
	const dueAt = input.dueAt ?? new Date(startsAt.getTime() + template.defaultDurationDays * DAY)
	const [project] = await db
		.insert(projects)
		.values({ templateId: template.id, chapterId: input.chapterId, teamId: input.teamId ?? null, name: input.name ?? template.name, ownerPersonId: input.ownerPersonId, startsAt, dueAt })
		.returning()
	const created: Task[] = []
	for (const step of template.steps) {
		const owner = step.defaultOwner === 'team' && input.teamId ? null : input.ownerPersonId
		const [task] = await db
			.insert(tasks)
			.values({
				projectId: project!.id,
				templateStepKey: step.key,
				title: step.title,
				description: step.description ?? null,
				ownerPersonId: owner,
				teamId: step.defaultOwner === 'team' ? (input.teamId ?? null) : null,
				chapterId: input.chapterId,
				assignedBy: input.assignedBy ?? null,
				dueAt: dueDateFor(step, startsAt, dueAt),
				actionKind: step.actionKind ?? null
			})
			.returning()
		created.push(task!)
	}
	return { project: project!, tasks: created, template }
}

export async function completeTask(taskId: string, byPersonId: string, db: Db = sharedDb()) {
	const [task] = await db
		.update(tasks)
		.set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
		.where(and(eq(tasks.id, taskId), inArray(tasks.status, ['open', 'in_progress', 'escalated'])))
		.returning()
	if (task?.ownerPersonId) {
		await logInteraction({ personId: task.ownerPersonId, kind: 'task_completed', subject: task.title, taskId: task.id, actorPersonId: byPersonId, chapterId: task.chapterId, visibility: 'team' }, db)
	}
	return task
}

/**
 * Who a missed task goes to: the project owner first, then an admin of the
 * chapter, then a global admin. Returns null when nobody is above the owner.
 */
export async function escalationTarget(task: Task, db: Db = sharedDb()): Promise<string | null> {
	if (task.projectId) {
		const project = await db.query.projects.findFirst({ where: eq(projects.id, task.projectId) })
		if (project?.ownerPersonId && project.ownerPersonId !== task.ownerPersonId) return project.ownerPersonId
	}
	if (task.chapterId) {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, task.chapterId) })
		if (chapter) {
			// Nearest chapter admin walking up the tree.
			const ancestors = ancestorPaths(chapter.path)
			const admins = await db
				.select({ personId: accessGrants.personId, path: chapters.path })
				.from(accessGrants)
				.innerJoin(chapters, eq(accessGrants.chapterId, chapters.id))
				.where(and(eq(accessGrants.role, 'chapter_admin'), inArray(chapters.path, ancestors)))
			admins.sort((a, b) => b.path.length - a.path.length)
			const admin = admins.find((a) => a.personId !== task.ownerPersonId)
			if (admin) return admin.personId
		}
	}
	const [global] = await db.select({ personId: accessGrants.personId }).from(accessGrants).where(eq(accessGrants.role, 'global_admin')).limit(1)
	return global && global.personId !== task.ownerPersonId ? global.personId : null
}

export function ancestorPaths(path: string): string[] {
	const parts = path.split('/').filter(Boolean)
	return parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'))
}

export type DeadlineSweepResult = { reminded: string[]; escalated: string[] }

/**
 * The scheduled sweep. Runs every hour:
 *  1. tasks due within `remindBeforeDays` and not yet reminded → reminder email;
 *  2. tasks past due by more than `graceDays` with no response since the
 *     reminder → escalate to the next person up and tell both.
 */
export async function deadlineSweep(
	options: { now?: Date; remindBeforeDays?: number; graceDays?: number } = {},
	db: Db = sharedDb()
): Promise<DeadlineSweepResult> {
	const now = options.now ?? new Date()
	const remindBefore = new Date(now.getTime() + (options.remindBeforeDays ?? 2) * DAY)
	const graceCutoff = new Date(now.getTime() - (options.graceDays ?? 2) * DAY)
	const result: DeadlineSweepResult = { reminded: [], escalated: [] }

	const toRemind = await db
		.select()
		.from(tasks)
		.where(and(inArray(tasks.status, ['open', 'in_progress']), isNotNull(tasks.ownerPersonId), isNotNull(tasks.dueAt), lte(tasks.dueAt, remindBefore), sql`${tasks.remindedAt} is null`))
	for (const task of toRemind) {
		const owner = await db.query.people.findFirst({ where: eq(people.id, task.ownerPersonId!) })
		if (owner?.email) {
			await sendEmail({
				to: [{ email: owner.email, name: owner.fullName }],
				subject: `Reminder: "${task.title}" is due ${task.dueAt!.toDateString()}`,
				text: `Hi ${owner.fullName || 'there'},\n\nA quick reminder that your task "${task.title}" is due on ${task.dueAt!.toDateString()}.\n\nOpen it here: ${env().APP_ORIGIN}/tasks/${task.id}\n\nIf you cannot do it, reply to this email or reassign it so someone else can pick it up.\n\nThanks for everything you do,\nPauseAI`,
				tags: ['task-reminder']
			})
		}
		await db.update(tasks).set({ remindedAt: now, updatedAt: now }).where(eq(tasks.id, task.id))
		result.reminded.push(task.id)
	}

	const overdue = await db
		.select()
		.from(tasks)
		.where(and(inArray(tasks.status, ['open', 'in_progress']), isNotNull(tasks.dueAt), lt(tasks.dueAt, graceCutoff), sql`${tasks.remindedAt} is not null`, sql`${tasks.updatedAt} <= ${tasks.remindedAt}`))
	for (const task of overdue) {
		const target = await escalationTarget(task, db)
		if (!target) continue
		const previousOwner = task.ownerPersonId
		await db
			.update(tasks)
			.set({ status: 'escalated', ownerPersonId: target, escalationLevel: task.escalationLevel + 1, escalatedAt: now, remindedAt: null, updatedAt: now })
			.where(eq(tasks.id, task.id))
		const [newOwner, oldOwner] = await Promise.all([
			db.query.people.findFirst({ where: eq(people.id, target) }),
			previousOwner ? db.query.people.findFirst({ where: eq(people.id, previousOwner) }) : Promise.resolve(undefined)
		])
		const recipients = [newOwner, oldOwner].filter((p): p is NonNullable<typeof p> => Boolean(p?.email)).map((p) => ({ email: p.email!, name: p.fullName }))
		if (recipients.length > 0) {
			await sendEmail({
				to: recipients,
				subject: `Task escalated: "${task.title}" missed its deadline`,
				text: `"${task.title}" was due on ${task.dueAt!.toDateString()} and had no update after the reminder, so it is now with ${newOwner?.fullName ?? 'the next person up'}.\n\nTask: ${env().APP_ORIGIN}/tasks/${task.id}\n\nNo blame attached: things come up. If ${oldOwner?.fullName ?? 'the previous owner'} can still do it, just reply here or reassign it back.`,
				tags: ['task-escalation']
			})
		}
		if (previousOwner) {
			await logInteraction({ personId: previousOwner, kind: 'note', subject: `Task "${task.title}" escalated after missed deadline`, taskId: task.id, chapterId: task.chapterId, visibility: 'leads' }, db)
		}
		result.escalated.push(task.id)
	}
	return result
}

/** Tasks a person can see on their own dashboard: theirs, plus their teams' unowned ones. */
export async function tasksFor(personId: string, db: Db = sharedDb()) {
	const teams = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.personId, personId))
	const teamIds = teams.map((t) => t.teamId)
	const where = teamIds.length
		? sql`(${tasks.ownerPersonId} = ${personId} or (${tasks.ownerPersonId} is null and ${tasks.teamId} in ${teamIds}))`
		: eq(tasks.ownerPersonId, personId)
	return db
		.select()
		.from(tasks)
		.where(and(where, inArray(tasks.status, ['open', 'in_progress', 'escalated'])))
		.orderBy(sql`${tasks.dueAt} asc nulls last`)
}

/** Volunteers who belong to a chapter but have no open task: the "always a next step" invariant. */
export async function idleVolunteers(chapterId: string, db: Db = sharedDb()) {
	return db
		.select({ person: people })
		.from(memberships)
		.innerJoin(people, eq(memberships.personId, people.id))
		.where(and(eq(memberships.chapterId, chapterId), eq(memberships.status, 'active'), sql`not exists (select 1 from tasks t where t.owner_person_id = ${people.id} and t.status in ('open','in_progress','escalated'))`))
}

export type { ProjectTemplate }
