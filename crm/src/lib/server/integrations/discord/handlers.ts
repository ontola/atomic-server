// What a Discord event means for the CRM:
//  - someone joined     → a person exists with a Discord identity; if their
//                         username matches a join-form row, the two are linked.
//  - roles changed      → country roles map to chapters, so add memberships.
//  - someone left       → mark memberships that only came from Discord as left.
// Every event is stored in webhook_events first, so a replay is a no-op.
import { and, eq, inArray } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../../db/client'
import { chapters, identities, memberships, webhookEvents } from '../../db/schema'
import { ensureMembership, findByIdentity, linkIdentity, logInteraction, upsertPerson } from '../../people'
import type { DiscordMember, PausebotEvent } from './webhook'

/** Store the event; returns false when we already had it. */
export async function recordEvent(event: PausebotEvent, db: Db = sharedDb()): Promise<boolean> {
	const [row] = await db
		.insert(webhookEvents)
		.values({ source: 'pausebot', externalId: event.id, payload: event as unknown as Record<string, unknown> })
		.onConflictDoNothing()
		.returning({ id: webhookEvents.id })
	return Boolean(row)
}

export async function markProcessed(eventId: string, error?: string, db: Db = sharedDb()) {
	await db
		.update(webhookEvents)
		.set({ processedAt: new Date(), error: error ?? null })
		.where(and(eq(webhookEvents.source, 'pausebot'), eq(webhookEvents.externalId, eventId)))
}

export async function handlePausebotEvent(event: PausebotEvent, db: Db = sharedDb()) {
	switch (event.type) {
		case 'member.joined':
			return onJoined(event.member, new Date(event.at), db)
		case 'member.roles_updated':
			return onRolesUpdated(event.member, event.added_role_ids, new Date(event.at), db)
		case 'member.left':
			return onLeft(event.member, new Date(event.at), db)
	}
}

/**
 * Resolve the Discord member to a person. Order: an existing Discord identity;
 * else a join-form row whose typed Discord username matches (stored as an
 * unverified `username:<name>` identity by the Airtable sync); else a new
 * person with only a Discord identity.
 */
export async function resolvePerson(member: DiscordMember, db: Db = sharedDb()) {
	const known = await findByIdentity('discord', member.id, db)
	if (known) return { person: known, created: false, matchedByUsername: false }

	const claimed = await findByIdentity('discord', usernameClaimId(member.username), db)
	if (claimed) {
		await linkIdentity(claimed.id, { provider: 'discord', externalId: member.id, handle: member.username, verified: true }, db)
		await db
			.delete(identities)
			.where(and(eq(identities.provider, 'discord'), eq(identities.externalId, usernameClaimId(member.username))))
		return { person: claimed, created: false, matchedByUsername: true }
	}
	const { person, created } = await upsertPerson(
		{ fullName: member.global_name ?? member.nick ?? member.username, kinds: ['volunteer'], source: 'discord' },
		{ provider: 'discord', externalId: member.id, handle: member.username, verified: true },
		db
	)
	return { person, created, matchedByUsername: false }
}

/** External id used for a username someone typed into a form before we knew their Discord id. */
export function usernameClaimId(username: string): string {
	return `username:${username.trim().replace(/^@/, '').replace(/#\d{4}$/, '').toLowerCase()}`
}

async function onJoined(member: DiscordMember, at: Date, db: Db) {
	const { person, created, matchedByUsername } = await resolvePerson(member, db)
	await logInteraction(
		{
			personId: person.id,
			kind: 'action_completed',
			channel: 'discord',
			subject: 'Joined the PauseAI Discord',
			occurredAt: at,
			externalRef: `discord:join:${member.id}:${at.toISOString()}`,
			meta: { created, matchedByUsername }
		},
		db
	)
	await applyRoles(person.id, member.role_ids, at, db)
	return person
}

async function onRolesUpdated(member: DiscordMember, added: string[], at: Date, db: Db) {
	const { person } = await resolvePerson(member, db)
	await applyRoles(person.id, added.length ? added : member.role_ids, at, db)
	return person
}

/** Country roles on Discord map to national chapters through `chapters.discord_role_id`. */
async function applyRoles(personId: string, roleIds: string[], at: Date, db: Db) {
	if (roleIds.length === 0) return
	const matches = await db.select().from(chapters).where(inArray(chapters.discordRoleId, roleIds))
	for (const chapter of matches) {
		await ensureMembership(personId, chapter.id, { role: 'member', source: 'discord' }, db)
		await logInteraction(
			{
				personId,
				kind: 'action_completed',
				channel: 'discord',
				subject: `Received the ${chapter.name} role on Discord`,
				chapterId: chapter.id,
				occurredAt: at,
				externalRef: `discord:role:${personId}:${chapter.id}`
			},
			db
		)
	}
}

async function onLeft(member: DiscordMember, at: Date, db: Db) {
	const person = await findByIdentity('discord', member.id, db)
	if (!person) return undefined
	await logInteraction(
		{ personId: person.id, kind: 'note', channel: 'discord', subject: 'Left the PauseAI Discord', occurredAt: at, externalRef: `discord:leave:${member.id}:${at.toISOString()}` },
		db
	)
	await db
		.update(memberships)
		.set({ status: 'left', leftAt: at })
		.where(and(eq(memberships.personId, person.id), eq(memberships.source, 'discord')))
	return person
}
