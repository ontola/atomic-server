// People visibility. Three tiers, decided per person and per actor:
//   self    — your own record, always.
//   scoped  — members of a chapter subtree you administer, or of a team you lead.
//   all     — global admins.
// Field tiers on top: contact details (email, phone, postcode) are only shown
// to admins of the person's chapter; everyone else in scope sees name, city
// and involvement. Interactions carry their own visibility.
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { chapters, memberships, people, teamMembers, type Person } from '../db/schema'
import { withinSubtrees } from '../chapters'
import { administersPath, type Actor } from './actor'

/** SQL predicate selecting the people this actor may see at all. */
export function visiblePeoplePredicate(actor: Actor): SQL {
	if (actor.isGlobalAdmin) return isNull(people.deletedAt)
	const clauses: SQL[] = [eq(people.id, actor.person.id)]
	if (actor.adminPaths.length > 0) {
		clauses.push(
			exists(
				sharedDb()
					.select({ one: sql`1` })
					.from(memberships)
					.innerJoin(chapters, eq(memberships.chapterId, chapters.id))
					.where(and(eq(memberships.personId, people.id), withinSubtrees(actor.adminPaths)))
			)
		)
	}
	if (actor.leadTeamIds.length > 0) {
		clauses.push(
			exists(
				sharedDb()
					.select({ one: sql`1` })
					.from(teamMembers)
					.where(and(eq(teamMembers.personId, people.id), inArray(teamMembers.teamId, actor.leadTeamIds)))
			)
		)
	}
	return and(isNull(people.deletedAt), or(...clauses)!)!
}

export type FieldTier = 'self' | 'admin' | 'scoped'

/** How much of this person's record the actor may see. Null means nothing at all. */
export async function tierFor(actor: Actor, personId: string, db: Db = sharedDb()): Promise<FieldTier | null> {
	if (personId === actor.person.id) return 'self'
	if (actor.isGlobalAdmin) return 'admin'
	const rows = await db
		.select({ path: chapters.path })
		.from(memberships)
		.innerJoin(chapters, eq(memberships.chapterId, chapters.id))
		.where(eq(memberships.personId, personId))
	if (rows.some((r) => administersPath(actor, r.path))) return 'admin'
	if (actor.leadTeamIds.length > 0) {
		const shared = await db
			.select({ teamId: teamMembers.teamId })
			.from(teamMembers)
			.where(and(eq(teamMembers.personId, personId), inArray(teamMembers.teamId, actor.leadTeamIds)))
			.limit(1)
		if (shared.length > 0) return 'scoped'
	}
	return null
}

const CONTACT_FIELDS = ['email', 'phone', 'postcode', 'latitude', 'longitude', 'airtableRecordId'] as const

/** Strip contact details for actors who only have scoped access. */
export function maskPerson<T extends Partial<Person>>(person: T, tier: FieldTier): T {
	if (tier !== 'scoped') return person
	const copy = { ...person }
	for (const field of CONTACT_FIELDS) if (field in copy) (copy as Record<string, unknown>)[field] = null
	return copy
}

export async function listVisiblePeople(actor: Actor, options: { limit?: number; offset?: number; search?: string } = {}, db: Db = sharedDb()) {
	const search = options.search?.trim()
	const where = search
		? and(visiblePeoplePredicate(actor), sql`(${people.fullName} ilike ${'%' + search + '%'} or ${people.email} ilike ${'%' + search + '%'} or ${people.city} ilike ${'%' + search + '%'})`)
		: visiblePeoplePredicate(actor)
	return db
		.select()
		.from(people)
		.where(where)
		.orderBy(sql`${people.updatedAt} desc`)
		.limit(options.limit ?? 50)
		.offset(options.offset ?? 0)
}
