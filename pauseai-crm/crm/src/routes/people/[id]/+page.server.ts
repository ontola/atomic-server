import { error } from '@sveltejs/kit'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PageServerLoad } from './$types'
import { requireActor } from '$server/authz/guard'
import { maskPerson, tierFor } from '$server/authz/people'
import { db } from '$server/db/client'
import { chapters, consents, identities, interactions, memberships, people, volunteerProfiles } from '$server/db/schema'

export const load: PageServerLoad = async ({ locals, params }) => {
	const actor = requireActor(locals.actor)
	const tier = await tierFor(actor, params.id)
	if (!tier) error(404, 'Person not found')
	const person = await db().query.people.findFirst({ where: eq(people.id, params.id) })
	if (!person) error(404, 'Person not found')
	const masked = maskPerson(person, tier)
	const visibility = tier === 'admin' ? ['team', 'leads', 'admins'] : tier === 'self' ? ['team', 'leads'] : ['team']
	const [profile, ids, ms, cs, timeline] = await Promise.all([
		db().query.volunteerProfiles.findFirst({ where: eq(volunteerProfiles.personId, person.id) }),
		tier === 'admin' ? db().select().from(identities).where(eq(identities.personId, person.id)) : Promise.resolve([]),
		db().select({ chapter: chapters.name, role: memberships.role, status: memberships.status }).from(memberships).innerJoin(chapters, eq(memberships.chapterId, chapters.id)).where(eq(memberships.personId, person.id)),
		tier === 'admin' ? db().select().from(consents).where(eq(consents.personId, person.id)).orderBy(desc(consents.recordedAt)) : Promise.resolve([]),
		db().select().from(interactions).where(and(eq(interactions.personId, person.id), inArray(interactions.visibility, visibility as ('team' | 'leads' | 'admins')[]))).orderBy(desc(interactions.occurredAt)).limit(100)
	])
	return {
		tier,
		person: { id: masked.id, name: masked.fullName, email: masked.email, phone: masked.phone, country: masked.country, city: masked.city, languages: masked.languages, kinds: masked.kinds, source: masked.source },
		profile: profile ? { intent: profile.intent, weeklyHours: profile.weeklyHours, skills: profile.skills, stage: profile.stage } : null,
		identities: ids.map((i) => ({ provider: i.provider, handle: i.handle ?? i.externalId, verified: Boolean(i.verifiedAt) })),
		memberships: ms,
		consents: latestConsents(cs),
		timeline: timeline.map((i) => ({ id: i.id, kind: i.kind, channel: i.channel, subject: i.subject, at: i.occurredAt.toISOString() }))
	}
}

function latestConsents(rows: (typeof consents.$inferSelect)[]) {
	const seen = new Map<string, boolean>()
	for (const r of rows) if (!seen.has(r.purpose)) seen.set(r.purpose, r.granted)
	return [...seen.entries()].map(([purpose, granted]) => ({ purpose, granted }))
}
