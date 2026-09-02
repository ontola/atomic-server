import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { SESSION_COOKIE, redeemMagicLink, sessionCookieOptions } from '$server/auth'

export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const token = url.searchParams.get('token') ?? ''
	const result = token ? await redeemMagicLink(token, request.headers.get('user-agent')) : null
	if (!result) redirect(303, '/login?expired=1')
	cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions())
	redirect(303, '/tasks')
}
