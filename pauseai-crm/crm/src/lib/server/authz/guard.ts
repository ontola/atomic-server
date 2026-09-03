import { error, redirect } from '@sveltejs/kit'
import type { Actor } from './actor'
import { isStaff } from './actor'

export function requireActor(actor: Actor | null): Actor {
	if (!actor) redirect(303, '/login')
	return actor
}

export function requireStaff(actor: Actor | null): Actor {
	const a = requireActor(actor)
	if (!isStaff(a)) error(403, 'You need a chapter or team role to see this page.')
	return a
}

export function requireGlobalAdmin(actor: Actor | null): Actor {
	const a = requireActor(actor)
	if (!a.isGlobalAdmin) error(403, 'Global admins only.')
	return a
}
