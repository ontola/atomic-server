import { describe, expect, it } from 'vitest'
import { useTestDb } from '../../../test/db'
import { IdentityConflictError, findByIdentity, hasConsent, linkIdentity, logInteraction, recordConsent, upsertPerson } from '../people'

const db = useTestDb()

describe('people', () => {
	it('finds by identity, then airtable id, then email; never overwrites an email', async () => {
		const a = await upsertPerson({ email: 'Ada@Example.org', fullName: 'Ada' }, undefined, db())
		expect(a.created).toBe(true)
		expect(a.person.email).toBe('ada@example.org')

		const b = await upsertPerson({ email: 'ada@example.org', city: 'Leeds', airtableRecordId: 'recAAA' }, { provider: 'airtable', externalId: 'recAAA' }, db())
		expect(b.created).toBe(false)
		expect(b.person.id).toBe(a.person.id)
		expect(b.person.city).toBe('Leeds')

		const c = await upsertPerson({ email: 'different@example.org', fullName: 'Ada L.' }, { provider: 'airtable', externalId: 'recAAA' }, db())
		expect(c.person.id).toBe(a.person.id)
		expect(c.person.email).toBe('ada@example.org')
		expect(c.person.fullName).toBe('Ada L.')
	})

	it('partial updates leave other fields alone and kinds accumulate', async () => {
		const { person } = await upsertPerson({ email: 'x@example.org', country: 'Germany', kinds: ['volunteer'] }, undefined, db())
		const { person: again } = await upsertPerson({ email: 'x@example.org', kinds: ['donor'] }, undefined, db())
		expect(again.country).toBe('Germany')
		expect(again.kinds).toEqual(['volunteer', 'donor'])
		expect(again.id).toBe(person.id)
	})

	it('refuses to move an identity between people', async () => {
		const a = await upsertPerson({ email: 'a@example.org' }, { provider: 'discord', externalId: '111' }, db())
		const b = await upsertPerson({ email: 'b@example.org' }, undefined, db())
		await expect(linkIdentity(b.person.id, { provider: 'discord', externalId: '111' }, db())).rejects.toBeInstanceOf(IdentityConflictError)
		expect((await findByIdentity('discord', '111', db()))?.id).toBe(a.person.id)
	})

	it('consent is append-only and the latest wins', async () => {
		const { person } = await upsertPerson({ email: 'c@example.org' }, undefined, db())
		await recordConsent(person.id, 'newsletter', true, 'join-form', {}, db())
		expect(await hasConsent(person.id, 'newsletter', db())).toBe(true)
		await recordConsent(person.id, 'newsletter', false, 'preferences', {}, db())
		expect(await hasConsent(person.id, 'newsletter', db())).toBe(false)
	})

	it('interactions dedupe on externalRef', async () => {
		const { person } = await upsertPerson({ email: 'd@example.org' }, undefined, db())
		const first = await logInteraction({ personId: person.id, kind: 'email_sent', externalRef: 'ms:1' }, db())
		const second = await logInteraction({ personId: person.id, kind: 'email_sent', externalRef: 'ms:1' }, db())
		expect(first).toBeDefined()
		expect(second).toBeUndefined()
	})
})
