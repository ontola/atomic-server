// Airtable → CRM import. Airtable stays the system of record for signups for
// now (the website writes there); the CRM mirrors it, incrementally, on a
// schedule. Everything here is idempotent: re-running a window is harmless.
//
// Cursor: the sync remembers the wall-clock time it started and next time
// asks Airtable for rows modified since then (minus a safety overlap). That
// relies on Airtable's LAST_MODIFIED_TIME(), which counts any field change.
import { eq } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { chapters, syncSources } from '../db/schema'
import { createChapter, ensureGlobalChapter, routeToChapter, slugify } from '../chapters'
import { env } from '../env'
import { AirtableClient } from '../integrations/airtable/client'
import { CHAPTER_FIELDS, mapChapter, type NationalGroupFields } from '../integrations/airtable/chapters'
import { MEMBER_FIELDS, isVolunteer, mapMember, type MappedMember, type MembersFields } from '../integrations/airtable/members'
import { IdentityConflictError, ensureMembership, linkIdentity, recordConsent, upsertPerson, upsertVolunteerProfile } from '../people'
import { usernameClaimId } from '../integrations/discord/handlers'

export const MEMBERS_SOURCE = 'airtable:members'
export const CHAPTERS_SOURCE = 'airtable:chapters'
const OVERLAP_MS = 10 * 60 * 1000

export type SyncReport = {
	source: string
	scanned: number
	created: number
	updated: number
	skipped: number
	drift: Record<string, Set<string>>
	errors: { recordId: string; message: string }[]
	startedAt: Date
	finishedAt: Date
}

function newReport(source: string): SyncReport {
	return { source, scanned: 0, created: 0, updated: 0, skipped: 0, drift: {}, errors: [], startedAt: new Date(), finishedAt: new Date() }
}

async function getCursor(source: string, db: Db) {
	const row = await db.query.syncSources.findFirst({ where: eq(syncSources.source, source) })
	return row?.cursor ?? null
}

async function finish(report: SyncReport, cursor: string | null, db: Db) {
	report.finishedAt = new Date()
	const stats = {
		scanned: report.scanned,
		created: report.created,
		updated: report.updated,
		skipped: report.skipped,
		errors: report.errors.length,
		drift: Object.fromEntries(Object.entries(report.drift).map(([k, v]) => [k, [...v]]))
	}
	const failed = report.errors.length > 0 && report.scanned === report.errors.length
	await db
		.insert(syncSources)
		.values({
			source: report.source,
			cursor: failed ? undefined : cursor,
			lastRunAt: report.finishedAt,
			lastSuccessAt: failed ? undefined : report.finishedAt,
			lastError: failed ? report.errors[0]?.message ?? 'failed' : null,
			stats
		})
		.onConflictDoUpdate({
			target: syncSources.source,
			set: {
				...(failed ? {} : { cursor, lastSuccessAt: report.finishedAt }),
				lastRunAt: report.finishedAt,
				lastError: failed ? report.errors[0]?.message ?? 'failed' : null,
				stats
			}
		})
	return report
}

function modifiedSinceFormula(cursor: string | null): string | undefined {
	if (!cursor) return undefined
	const since = new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString()
	return `IS_AFTER(LAST_MODIFIED_TIME(), '${since}')`
}

export async function syncChapters(
	client: AirtableClient,
	options: { baseId?: string; tableId?: string } = {},
	db: Db = sharedDb()
): Promise<SyncReport> {
	const report = newReport(CHAPTERS_SOURCE)
	const global = await ensureGlobalChapter(db)
	const baseId = options.baseId ?? env().AIRTABLE_BASE_ID
	const tableId = options.tableId ?? env().AIRTABLE_CHAPTERS_TABLE_ID
	for await (const record of client.list<NationalGroupFields>(baseId, tableId, { fields: CHAPTER_FIELDS })) {
		report.scanned++
		const mapped = mapChapter(record)
		if (!mapped) {
			report.skipped++
			continue
		}
		try {
			const existing = await db.query.chapters.findFirst({ where: eq(chapters.airtableRecordId, mapped.airtableRecordId) })
			if (existing) {
				await db
					.update(chapters)
					.set({ name: mapped.name, country: mapped.country, email: mapped.email, whatsappUrl: mapped.whatsappUrl, websiteUrl: mapped.websiteUrl, active: mapped.active, updatedAt: new Date() })
					.where(eq(chapters.id, existing.id))
				report.updated++
			} else {
				await createChapter({ ...mapped, kind: 'national', parentId: global.id, slug: slugify(mapped.country) }, db)
				report.created++
			}
		} catch (error) {
			report.errors.push({ recordId: record.id, message: error instanceof Error ? error.message : String(error) })
		}
	}
	return finish(report, report.startedAt.toISOString(), db)
}

export async function syncMembers(
	client: AirtableClient,
	options: { baseId?: string; tableId?: string; full?: boolean; limit?: number } = {},
	db: Db = sharedDb()
): Promise<SyncReport> {
	const report = newReport(MEMBERS_SOURCE)
	const baseId = options.baseId ?? env().AIRTABLE_BASE_ID
	const tableId = options.tableId ?? env().AIRTABLE_MEMBERS_TABLE_ID
	const cursor = options.full ? null : await getCursor(MEMBERS_SOURCE, db)
	const filterByFormula = modifiedSinceFormula(cursor)
	for await (const record of client.list<MembersFields>(baseId, tableId, { fields: MEMBER_FIELDS, filterByFormula, limit: options.limit })) {
		report.scanned++
		try {
			const mapped = mapMember(record)
			for (const d of mapped.drift) (report.drift[d.field] ??= new Set()).add(d.value)
			if (mapped.duplicate || (!mapped.person.email && !mapped.person.fullName)) {
				report.skipped++
				continue
			}
			const { created } = await importMember(mapped, db)
			if (created) report.created++
			else report.updated++
		} catch (error) {
			report.errors.push({ recordId: record.id, message: error instanceof Error ? error.message : String(error) })
		}
	}
	return finish(report, report.startedAt.toISOString(), db)
}

/** Write one mapped Airtable row into the CRM. Exported so tests and one-off scripts can reuse it. */
export async function importMember(mapped: MappedMember, db: Db = sharedDb()) {
	const volunteer = isVolunteer(mapped)
	const { person, created } = await upsertPerson(
		{
			...mapped.person,
			airtableRecordId: mapped.airtableRecordId,
			kinds: volunteer ? ['volunteer'] : ['subscriber'],
			source: mapped.source ?? 'airtable',
			sourcePage: mapped.sourcePage
		},
		{ provider: 'airtable', externalId: mapped.airtableRecordId },
		db
	)
	if (mapped.discordUsername) {
		// A typed username is a claim, not a verified identity. Store it as an
		// unverified identity; the Discord handlers upgrade it to the real id
		// the moment PauseBot reports that username joining the server.
		try {
			await linkIdentity(person.id, { provider: 'discord', externalId: usernameClaimId(mapped.discordUsername), handle: mapped.discordUsername }, db)
		} catch (error) {
			if (!(error instanceof IdentityConflictError)) throw error
			// Two rows claim the same username: leave the first claim in place and note it.
		}
	}
	if (volunteer || mapped.profile.intent) {
		await upsertVolunteerProfile(person.id, { ...mapped.profile }, db)
	}
	for (const c of mapped.consents) {
		await recordConsent(person.id, c.purpose, c.granted, 'airtable:members', { recordId: mapped.airtableRecordId }, db)
	}
	const chapter = await routeToChapter({ country: mapped.person.country }, {}, db)
	await ensureMembership(
		person.id,
		chapter.id,
		{ role: volunteer ? 'volunteer' : 'member', ...(created ? { status: volunteer ? 'onboarding' : 'prospect' } : {}), source: 'airtable:members' },
		db
	)
	return { person, created, chapter }
}

/** Convenience for the CLI and the scheduled job. */
export async function runAirtableSync(options: { full?: boolean; limit?: number } = {}, db: Db = sharedDb()) {
	const key = env().AIRTABLE_API_KEY
	if (!key) throw new Error('AIRTABLE_API_KEY is not set')
	const client = new AirtableClient(key)
	const chaptersReport = await syncChapters(client, {}, db)
	const membersReport = await syncMembers(client, options, db)
	return { chapters: chaptersReport, members: membersReport }
}
