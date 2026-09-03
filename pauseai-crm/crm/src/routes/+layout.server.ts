import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = async ({ locals }) => {
	const a = locals.actor
	return {
		me: a ? { id: a.person.id, name: a.person.fullName, email: a.person.email, isGlobalAdmin: a.isGlobalAdmin, isStaff: a.isGlobalAdmin || a.adminPaths.length > 0 || a.leadTeamIds.length > 0 } : null
	}
}
