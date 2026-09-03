import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { SESSION_COOKIE, signOut } from '$server/auth'

export const POST: RequestHandler = async ({ cookies }) => {
	await signOut(cookies.get(SESSION_COOKIE))
	cookies.delete(SESSION_COOKIE, { path: '/' })
	redirect(303, '/')
}
