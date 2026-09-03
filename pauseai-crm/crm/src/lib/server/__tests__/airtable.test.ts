import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useTestDb } from '../../../test/db'
import { AirtableClient } from '../integrations/airtable/client'
import { mapMember, normalizeDiscordUsername } from '../integrations/airtable/members'
import { chapters, memberships, people } from '../db/schema'
import { syncChapters, syncMembers } from '../sync/airtable'
import { hasConsent } from '../people'

const db = useTestDb()

/** A fetch that serves canned Airtable pages and records the requests it saw. */
function fakeAirtable(tables: Record<string, Record<string, unknown>[]>) {
	const requests: URL[] = []
	const fetchImpl: typeof fetch = async (input) => {
		const url = new URL(String(input instanceof Request ? input.url : input))
		requests.push(url)
		const tableId = url.pathname.split('/').pop()!
		const rows = tables[tableId] ?? []
		const pageSize = Number(url.searchParams.get('pageSize') ?? 100)
		const offset = Number(url.searchParams.get('offset') ?? 0)
		const page = rows.slice(offset, offset + pageSize).map((fields, i) => ({ id: (fields.__id as string) ?? `rec${offset + i}`, createdTime: '2026-01-01T00:00:00.000Z', fields }))
		const body = { records: page, ...(offset + pageSize < rows.length ? { offset: String(offset + pageSize) } : {}) }
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}
	return { requests, client: new AirtableClient('key', fetchImpl, 0) }
}

describe('airtable mapping', () => {
	it('maps canonical fields and reports vocabulary drift without failing', () => {
		const m = mapMember({
			id: 'rec1',
			createdTime: '',
			fields: {
				Email: 'Volunteer@Example.org ',
				'Full name': 'Vol Unteer',
				Country: 'United Kingdom',
				City: 'Bristol',
				'Discord Username': '@VolUnteer#1234',
				Languages: ['English', 'Klingon'],
				Intent: 'Volunteer',
				'Signup source': 'June 2026 onboarding flow',
				'Email subscription': true,
				'GDPR chapter share permission': true,
				'Data privacy policy agreed': true,
				'Volunteer Agreement': true,
				'Projected weekly hours': '3-6 hours',
				'Skills & Interests': ['Writing', 'Juggling'],
				Motivation: ['AI Safety']
			}
		})
		expect(m.person.email).toBe('volunteer@example.org')
		expect(m.discordUsername).toBe('volunteer')
		expect(m.profile.weeklyHours).toBe('3-6 hours')
		expect(m.consents).toContainEqual({ purpose: 'newsletter', granted: true })
		expect(m.drift).toEqual([{ field: 'Skills & Interests', value: 'Juggling' }])
	})

	it('normalises discord usernames', () => {
		expect(normalizeDiscordUsername(' @Some.One#0001 ')).toBe('some.one')
		expect(normalizeDiscordUsername('')).toBeNull()
	})
})

describe('airtable sync', () => {
	it('imports chapters then members, routes them, and is idempotent', async () => {
		const { client, requests } = fakeAirtable({
			tblChapters: [
				{ __id: 'recUK', country: 'United Kingdom', website_email: 'uk@pauseai.info' },
				{ __id: 'recOld', country: 'Atlantis', inactive: true },
				{ __id: 'recBlank' }
			],
			tblMembers: [
				{ __id: 'recA', Email: 'a@example.org', 'Full name': 'A', Country: 'United Kingdom', Intent: 'Volunteer', 'Volunteer Agreement': true, 'Email subscription': true, 'Discord Username': 'a_user' },
				{ __id: 'recB', Email: 'b@example.org', 'Full name': 'B', Country: 'Nowhere', Intent: 'Keep informed', 'Email subscription': false },
				{ __id: 'recDup', Email: 'a@example.org', 'Full name': 'A again', duplicate: true },
				{ __id: 'recEmpty' }
			]
		})
		const ch = await syncChapters(client, { baseId: 'base', tableId: 'tblChapters' }, db())
		expect(ch).toMatchObject({ scanned: 3, created: 2, skipped: 1, errors: [] })
		const uk = await db().query.chapters.findFirst({ where: eq(chapters.country, 'United Kingdom') })
		expect(uk?.kind).toBe('national')
		expect(uk?.email).toBe('uk@pauseai.info')

		const first = await syncMembers(client, { baseId: 'base', tableId: 'tblMembers' }, db())
		expect(first).toMatchObject({ scanned: 4, created: 2, updated: 0, skipped: 2, errors: [] })
		const a = await db().query.people.findFirst({ where: eq(people.email, 'a@example.org') })
		expect(a?.kinds).toEqual(['volunteer'])
		expect(await hasConsent(a!.id, 'newsletter', db())).toBe(true)
		const aMemberships = await db().select().from(memberships).where(eq(memberships.personId, a!.id))
		expect(aMemberships).toHaveLength(1)
		expect(aMemberships[0]!.chapterId).toBe(uk!.id)
		expect(aMemberships[0]!.role).toBe('volunteer')
		expect(aMemberships[0]!.status).toBe('onboarding')

		const b = await db().query.people.findFirst({ where: eq(people.email, 'b@example.org') })
		const bMemberships = await db().select({ path: chapters.path }).from(memberships).innerJoin(chapters, eq(memberships.chapterId, chapters.id)).where(eq(memberships.personId, b!.id))
		expect(bMemberships[0]!.path).toBe('/global')

		// Second run: incremental (asks for modified rows), nothing created.
		const second = await syncMembers(client, { baseId: 'base', tableId: 'tblMembers' }, db())
		expect(second).toMatchObject({ created: 0, updated: 2 })
		const lastRequest = requests.at(-1)!
		expect(lastRequest.searchParams.get('filterByFormula')).toMatch(/IS_AFTER\(LAST_MODIFIED_TIME\(\)/)
		expect(await db().select().from(people)).toHaveLength(2)
	})

	it('follows pagination and respects a limit', async () => {
		const rows = Array.from({ length: 250 }, (_, i) => ({ __id: `rec${i}`, Email: `p${i}@example.org`, 'Full name': `P${i}` }))
		const { client } = fakeAirtable({ tblMembers: rows })
		const all = await syncMembers(client, { baseId: 'base', tableId: 'tblMembers' }, db())
		expect(all.created).toBe(250)
		const limited = await syncMembers(client, { baseId: 'base', tableId: 'tblMembers', full: true, limit: 7 }, db())
		expect(limited.scanned).toBe(7)
	})
})
