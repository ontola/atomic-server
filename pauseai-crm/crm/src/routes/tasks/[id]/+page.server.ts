import { error } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import type { PageServerLoad } from './$types'
import { requireActor } from '$server/authz/guard'
import { administersPath } from '$server/authz/actor'
import { db } from '$server/db/client'
import { chapters, people, tasks } from '$server/db/schema'

export const load: PageServerLoad = async ({ locals, params }) => {
	const actor = requireActor(locals.actor)
	const task = await db().query.tasks.findFirst({ where: eq(tasks.id, params.id) })
	if (!task) error(404, 'Task not found')
	const chapter = task.chapterId ? await db().query.chapters.findFirst({ where: eq(chapters.id, task.chapterId) }) : undefined
	const mine = task.ownerPersonId === actor.person.id || (task.teamId !== null && actor.teamIds.includes(task.teamId))
	if (!mine && !(chapter && administersPath(actor, chapter.path))) error(403, 'Not your task')
	const owner = task.ownerPersonId ? await db().query.people.findFirst({ where: eq(people.id, task.ownerPersonId) }) : undefined
	return {
		task: { id: task.id, title: task.title, description: task.description, status: task.status, dueAt: task.dueAt?.toISOString() ?? null, escalationLevel: task.escalationLevel, actionKind: task.actionKind },
		owner: owner ? { name: owner.fullName } : null,
		chapter: chapter ? { name: chapter.name } : null
	}
}
