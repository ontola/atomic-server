// Who is asking, and what may they see? An Actor is the signed-in person plus
// their grants resolved to chapter subtrees. Built once per request in
// hooks.server.ts and passed down; never rebuilt from Discord roles or cookies
// elsewhere.
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { accessGrants, chapters, teamMembers, type Person } from '../db/schema'

export type Role = 'global_admin' | 'chapter_admin' | 'team_lead' | 'volunteer'

export type Actor = {
	person: Person
	isGlobalAdmin: boolean
	/** Chapter paths this actor administers (the chapter and everything below). */
	adminPaths: string[]
	/** Teams this actor leads. */
	leadTeamIds: string[]
	/** Teams this actor belongs to. */
	teamIds: string[]
	roles: Role[]
}

export async function buildActor(person: Person, db: Db = sharedDb()): Promise<Actor> {
	const now = new Date()
	const grants = await db
		.select({ role: accessGrants.role, chapterId: accessGrants.chapterId, teamId: accessGrants.teamId, path: chapters.path })
		.from(accessGrants)
		.leftJoin(chapters, eq(accessGrants.chapterId, chapters.id))
		.where(and(eq(accessGrants.personId, person.id), or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, now))))
	const teams = await db.select({ teamId: teamMembers.teamId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.personId, person.id))

	const actor: Actor = {
		person,
		isGlobalAdmin: false,
		adminPaths: [],
		leadTeamIds: [],
		teamIds: teams.map((t) => t.teamId),
		roles: []
	}
	for (const g of grants) {
		if (!actor.roles.includes(g.role)) actor.roles.push(g.role)
		if (g.role === 'global_admin') actor.isGlobalAdmin = true
		if (g.role === 'chapter_admin' && g.path) actor.adminPaths.push(g.path)
		if (g.role === 'team_lead' && g.teamId) actor.leadTeamIds.push(g.teamId)
	}
	for (const t of teams) if (t.role === 'lead' && !actor.leadTeamIds.includes(t.teamId)) actor.leadTeamIds.push(t.teamId)
	return actor
}

/** Does the actor administer the chapter at this path? */
export function administersPath(actor: Actor, path: string): boolean {
	if (actor.isGlobalAdmin) return true
	return actor.adminPaths.some((p) => path === p || path.startsWith(`${p}/`))
}

export function isStaff(actor: Actor): boolean {
	return actor.isGlobalAdmin || actor.adminPaths.length > 0 || actor.leadTeamIds.length > 0
}
