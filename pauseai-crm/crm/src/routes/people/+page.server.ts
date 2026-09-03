import type { PageServerLoad } from './$types'
import { requireStaff } from '$server/authz/guard'
import { listVisiblePeople } from '$server/authz/people'

export const load: PageServerLoad = async ({ locals, url }) => {
	const actor = requireStaff(locals.actor)
	const search = url.searchParams.get('q') ?? ''
	const rows = await listVisiblePeople(actor, { search, limit: 100 })
	return {
		search,
		people: rows.map((p) => ({ id: p.id, name: p.fullName, email: actor.isGlobalAdmin || actor.adminPaths.length ? p.email : null, country: p.country, city: p.city, kinds: p.kinds, updatedAt: p.updatedAt.toISOString() }))
	}
}
