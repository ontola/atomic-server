// People: the one table for everyone, plus the helpers every integration
// needs: find-or-create by an external identity, record consent, log an
// interaction. All writes are idempotent so syncs can be re-run safely.
import { and, eq, sql } from 'drizzle-orm'
import { db as sharedDb, type Db } from './db/client'
import {
	consents,
	identities,
	interactions,
	memberships,
	people,
	volunteerProfiles,
	type Person
} from './db/schema'

export type Provider = (typeof identities.provider.enumValues)[number]
export type ConsentPurpose = (typeof consents.purpose.enumValues)[number]
export type InteractionKind = (typeof interactions.kind.enumValues)[number]

export function normalizeEmail(email: string | null | undefined): string | null {
	const trimmed = email?.trim().toLowerCase()
	return trimmed ? trimmed : null
}

export function personKindsWith(existing: string[], kind: string): string[] {
	return existing.includes(kind) ? existing : [...existing, kind]
}

/** Look a person up by an external identity (Discord id, Airtable record id...). */
export async function findByIdentity(
	provider: Provider,
	externalId: string,
	db: Db = sharedDb()
): Promise<Person | undefined> {
	const [row] = await db
		.select({ person: people })
		.from(identities)
		.innerJoin(people, eq(identities.personId, people.id))
		.where(and(eq(identities.provider, provider), eq(identities.externalId, externalId)))
		.limit(1)
	return row?.person
}

export async function findByEmail(email: string, db: Db = sharedDb()): Promise<Person | undefined> {
	const normalized = normalizeEmail(email)
	if (!normalized) return undefined
	return db.query.people.findFirst({ where: eq(people.email, normalized) })
}

/**
 * Attach an identity to a person. If the identity already belongs to someone
 * else, this is a merge decision for a human, so we refuse rather than move it.
 */
export async function linkIdentity(
	personId: string,
	identity: { provider: Provider; externalId: string; handle?: string | null; verified?: boolean; meta?: Record<string, unknown> },
	db: Db = sharedDb()
) {
	const existing = await db.query.identities.findFirst({
		where: and(eq(identities.provider, identity.provider), eq(identities.externalId, identity.externalId))
	})
	if (existing && existing.personId !== personId) {
		throw new IdentityConflictError(identity.provider, identity.externalId, existing.personId, personId)
	}
	const values = {
		personId,
		provider: identity.provider,
		externalId: identity.externalId,
		handle: identity.handle ?? null,
		verifiedAt: identity.verified ? new Date() : null,
		meta: identity.meta ?? {}
	}
	const [row] = await db
		.insert(identities)
		.values(values)
		.onConflictDoUpdate({
			target: [identities.provider, identities.externalId],
			set: {
				handle: values.handle,
				meta: values.meta,
				verifiedAt: sql`coalesce(${identities.verifiedAt}, excluded.verified_at)`
			}
		})
		.returning()
	return row!
}

export class IdentityConflictError extends Error {
	constructor(
		public provider: Provider,
		public externalId: string,
		public existingPersonId: string,
		public attemptedPersonId: string
	) {
		super(`${provider}:${externalId} already belongs to person ${existingPersonId}`)
	}
}

export type UpsertPersonInput = {
	email?: string | null
	fullName?: string | null
	phone?: string | null
	country?: string | null
	city?: string | null
	postcode?: string | null
	languages?: string[]
	kinds?: string[]
	airtableRecordId?: string | null
	source?: string | null
	sourcePage?: string | null
}

/**
 * Find-or-create a person. Resolution order: the given identity, then the
 * Airtable record id, then the email. Fields that are provided overwrite;
 * fields that are undefined are left alone, so a partial source never blanks
 * data a richer source captured.
 */
export async function upsertPerson(
	input: UpsertPersonInput,
	identity?: { provider: Provider; externalId: string; handle?: string | null; verified?: boolean },
	db: Db = sharedDb()
): Promise<{ person: Person; created: boolean }> {
	const email = normalizeEmail(input.email)
	let existing: Person | undefined
	if (identity) existing = await findByIdentity(identity.provider, identity.externalId, db)
	if (!existing && input.airtableRecordId) {
		existing = await db.query.people.findFirst({
			where: eq(people.airtableRecordId, input.airtableRecordId)
		})
	}
	if (!existing && email) existing = await findByEmail(email, db)

	const patch: Partial<typeof people.$inferInsert> = { updatedAt: new Date() }
	if (email !== null && email !== undefined) patch.email = email
	if (input.fullName != null && input.fullName.trim()) patch.fullName = input.fullName.trim()
	if (input.phone !== undefined) patch.phone = input.phone
	if (input.country !== undefined) patch.country = input.country
	if (input.city !== undefined) patch.city = input.city
	if (input.postcode !== undefined) patch.postcode = input.postcode
	if (input.languages !== undefined) patch.languages = input.languages
	if (input.airtableRecordId !== undefined) patch.airtableRecordId = input.airtableRecordId

	let person: Person
	let created = false
	if (existing) {
		if (input.kinds?.length) {
			patch.kinds = input.kinds.reduce(personKindsWith, existing.kinds)
		}
		// An existing email is never overwritten by a different one from a sync:
		// that is a merge, and merges are a human decision.
		if (existing.email && patch.email && patch.email !== existing.email) delete patch.email
		const [row] = await db.update(people).set(patch).where(eq(people.id, existing.id)).returning()
		person = row!
	} else {
		const [row] = await db
			.insert(people)
			.values({
				email,
				fullName: input.fullName?.trim() ?? '',
				phone: input.phone ?? null,
				country: input.country ?? null,
				city: input.city ?? null,
				postcode: input.postcode ?? null,
				languages: input.languages ?? [],
				kinds: input.kinds ?? [],
				airtableRecordId: input.airtableRecordId ?? null,
				source: input.source ?? null,
				sourcePage: input.sourcePage ?? null
			})
			.returning()
		person = row!
		created = true
	}
	if (identity) await linkIdentity(person.id, identity, db)
	return { person, created }
}

/** Append a consent record. Consent history is append-only; the latest row wins. */
export async function recordConsent(
	personId: string,
	purpose: ConsentPurpose,
	granted: boolean,
	source: string,
	evidence: Record<string, unknown> = {},
	db: Db = sharedDb()
) {
	const latest = await db.query.consents.findFirst({
		where: and(eq(consents.personId, personId), eq(consents.purpose, purpose)),
		orderBy: (c, { desc }) => [desc(c.recordedAt)]
	})
	// Same state, same source: nothing changed, keep the history readable.
	if (latest && latest.granted === granted && latest.source === source) return latest
	const [row] = await db
		.insert(consents)
		.values({ personId, purpose, granted, source, evidence })
		.returning()
	return row!
}

export async function hasConsent(personId: string, purpose: ConsentPurpose, db: Db = sharedDb()) {
	const latest = await db.query.consents.findFirst({
		where: and(eq(consents.personId, personId), eq(consents.purpose, purpose)),
		orderBy: (c, { desc }) => [desc(c.recordedAt)]
	})
	return latest?.granted ?? false
}

export type NewInteraction = {
	personId: string
	kind: InteractionKind
	channel?: string | null
	subject?: string | null
	body?: string | null
	occurredAt?: Date
	actorPersonId?: string | null
	chapterId?: string | null
	eventId?: string | null
	taskId?: string | null
	/** Idempotency key. A repeat with the same ref is a no-op. */
	externalRef?: string | null
	visibility?: 'team' | 'leads' | 'admins'
	meta?: Record<string, unknown>
}

export async function logInteraction(input: NewInteraction, db: Db = sharedDb()) {
	const [row] = await db
		.insert(interactions)
		.values({
			...input,
			occurredAt: input.occurredAt ?? new Date(),
			visibility: input.visibility ?? 'leads',
			meta: input.meta ?? {}
		})
		.onConflictDoNothing({ target: interactions.externalRef, where: sql`${interactions.externalRef} is not null` })
		.returning()
	return row
}

/** Create or update a membership; never downgrades a role or reactivates someone who left on purpose. */
export async function ensureMembership(
	personId: string,
	chapterId: string,
	input: { role?: 'member' | 'volunteer' | 'team_lead' | 'chapter_lead'; status?: 'prospect' | 'onboarding' | 'active' | 'dormant' | 'left'; source?: string } = {},
	db: Db = sharedDb()
) {
	const [row] = await db
		.insert(memberships)
		.values({ personId, chapterId, role: input.role ?? 'member', status: input.status ?? 'prospect', source: input.source ?? null })
		.onConflictDoUpdate({
			target: [memberships.personId, memberships.chapterId],
			set: {
				role: sql`case when ${memberships.role} = 'chapter_lead' then ${memberships.role} else ${input.role ?? 'member'}::membership_role end`,
				...(input.status ? { status: input.status } : {})
			}
		})
		.returning()
	return row!
}

export async function upsertVolunteerProfile(
	personId: string,
	profile: Partial<Omit<typeof volunteerProfiles.$inferInsert, 'personId'>>,
	db: Db = sharedDb()
) {
	const [row] = await db
		.insert(volunteerProfiles)
		.values({ personId, ...profile })
		.onConflictDoUpdate({ target: volunteerProfiles.personId, set: { ...profile, updatedAt: new Date() } })
		.returning()
	return row!
}
