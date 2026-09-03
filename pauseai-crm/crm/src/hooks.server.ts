import type { Handle } from '@sveltejs/kit'
import { SESSION_COOKIE, sessionFromToken } from '$server/auth'
import { buildActor } from '$server/authz/actor'
// Registers job handlers so the web process can enqueue and, in dev, run them.
import '$server/jobs/handlers'

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE)
	const session = await sessionFromToken(token)
	event.locals.actor = session ? await buildActor(session.person) : null
	event.locals.sessionId = session?.session.id ?? null
	const response = await resolve(event)
	response.headers.set('X-Frame-Options', 'DENY')
	response.headers.set('X-Content-Type-Options', 'nosniff')
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
	return response
}
