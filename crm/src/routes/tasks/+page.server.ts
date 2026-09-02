import type { Actions, PageServerLoad } from './$types'
import { requireActor } from '$server/authz/guard'
import { completeTask, tasksFor } from '$server/tasks'
import { fail } from '@sveltejs/kit'

export const load: PageServerLoad = async ({ locals }) => {
	const actor = requireActor(locals.actor)
	const tasks = await tasksFor(actor.person.id)
	return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, dueAt: t.dueAt?.toISOString() ?? null, status: t.status, escalationLevel: t.escalationLevel })) }
}

export const actions: Actions = {
	complete: async ({ locals, request }) => {
		const actor = requireActor(locals.actor)
		const id = String((await request.formData()).get('id') ?? '')
		const mine = (await tasksFor(actor.person.id)).some((t) => t.id === id)
		if (!mine) return fail(403, { message: 'Not your task.' })
		await completeTask(id, actor.person.id)
		return { done: id }
	}
}
