import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useTestDb } from '../../../test/db'
import { createChapter, ensureGlobalChapter } from '../chapters'
import { identities, memberships } from '../db/schema'
import { handlePausebotEvent, recordEvent, resolvePerson, usernameClaimId } from '../integrations/discord/handlers'
import { pausebotEvent, sign, verifySignature } from '../integrations/discord/webhook'
import { findByIdentity, linkIdentity, upsertPerson } from '../people'

const db = useTestDb()

describe('pausebot signature', () => {
	it('accepts a fresh, correctly signed body and rejects everything else', () => {
		const body = '{"hello":"world"}'
		const ts = String(Math.floor(Date.now() / 1000))
		const sig = sign('s3cret', ts, body)
		expect(verifySignature('s3cret', { signature: sig, timestamp: ts }, body)).toEqual({ ok: true })
		expect(verifySignature('s3cret', { signature: `sha256=${sig}`, timestamp: ts }, body)).toEqual({ ok: true })
		expect(verifySignature('other', { signature: sig, timestamp: ts }, body).ok).toBe(false)
		expect(verifySignature('s3cret', { signature: sig, timestamp: ts }, body + ' ').ok).toBe(false)
		const old = String(Math.floor(Date.now() / 1000) - 600)
		expect(verifySignature('s3cret', { signature: sign('s3cret', old, body), timestamp: old }, body).ok).toBe(false)
		expect(verifySignature('s3cret', { signature: null, timestamp: ts }, body).ok).toBe(false)
	})

	it('parses the event schema', () => {
		const ev = pausebotEvent.parse({ id: 'e1', type: 'member.joined', at: '2026-09-01T10:00:00Z', member: { id: '42', username: 'someone' } })
		expect(ev.member.role_ids).toEqual([])
		expect(() => pausebotEvent.parse({ id: 'e1', type: 'member.exploded', at: '', member: {} })).toThrow()
	})
})

describe('discord handlers', () => {
	it('links a join to the person who typed that username on the join form', async () => {
		const { person } = await upsertPerson({ email: 'form@example.org', fullName: 'Form Person' }, undefined, db())
		await linkIdentity(person.id, { provider: 'discord', externalId: usernameClaimId('@Form.Person#0001'), handle: 'form.person' }, db())
		const resolved = await resolvePerson({ id: '9001', username: 'form.person', role_ids: [] }, db())
		expect(resolved.person.id).toBe(person.id)
		expect(resolved.matchedByUsername).toBe(true)
		const ids = await db().select().from(identities).where(eq(identities.personId, person.id))
		expect(ids.map((i) => i.externalId)).toEqual(['9001'])
		expect(ids[0]!.verifiedAt).not.toBeNull()
	})

	it('creates a person for an unknown member and maps country roles to chapters', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id, country: 'United Kingdom', discordRoleId: 'role-uk' }, db())
		const event = pausebotEvent.parse({ id: 'e1', type: 'member.joined', at: '2026-09-01T10:00:00Z', member: { id: '77', username: 'newbie', global_name: 'New Bie', role_ids: [] } })
		expect(await recordEvent(event, db())).toBe(true)
		expect(await recordEvent(event, db())).toBe(false)
		await handlePausebotEvent(event, db())
		const person = await findByIdentity('discord', '77', db())
		expect(person?.fullName).toBe('New Bie')
		expect(await db().select().from(memberships).where(eq(memberships.personId, person!.id))).toHaveLength(0)

		await handlePausebotEvent(pausebotEvent.parse({ id: 'e2', type: 'member.roles_updated', at: '2026-09-01T10:05:00Z', member: { id: '77', username: 'newbie', role_ids: ['role-uk', 'role-other'] }, added_role_ids: ['role-uk'] }), db())
		const ms = await db().select().from(memberships).where(eq(memberships.personId, person!.id))
		expect(ms).toHaveLength(1)
		expect(ms[0]!.chapterId).toBe(uk.id)
		expect(ms[0]!.source).toBe('discord')

		await handlePausebotEvent(pausebotEvent.parse({ id: 'e3', type: 'member.left', at: '2026-09-02T10:00:00Z', member: { id: '77', username: 'newbie' } }), db())
		const after = await db().select().from(memberships).where(eq(memberships.personId, person!.id))
		expect(after[0]!.status).toBe('left')
	})
})
