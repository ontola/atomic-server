import { fail, redirect } from '@sveltejs/kit'
import type { Actions, PageServerLoad } from './$types'
import { requestMagicLink } from '$server/auth'

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.actor) redirect(303, '/tasks')
	return {}
}

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData()
		const email = String(data.get('email') ?? '').trim()
		if (!email.includes('@')) return fail(400, { message: 'Please enter your email address.' })
		const { link } = await requestMagicLink(email)
		return { sent: true, link }
	}
}
