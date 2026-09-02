import { asc, count, eq } from 'drizzle-orm'
import type { PageServerLoad } from './$types'
import { requireStaff } from '$server/authz/guard'
import { administersPath } from '$server/authz/actor'
import { db } from '$server/db/client'
import { chapters, memberships } from '$server/db/schema'

export const load: PageServerLoad = async ({ locals }) => {
	const actor = requireStaff(locals.actor)
	const rows = await db()
		.select({ id: chapters.id, name: chapters.name, kind: chapters.kind, path: chapters.path, country: chapters.country, active: chapters.active, members: count(memberships.id) })
		.from(chapters)
		.leftJoin(memberships, eq(memberships.chapterId, chapters.id))
		.groupBy(chapters.id)
		.orderBy(asc(chapters.path))
	return { chapters: rows.map((c) => ({ ...c, depth: c.path.split('/').length - 2, mine: administersPath(actor, c.path) })) }
}
