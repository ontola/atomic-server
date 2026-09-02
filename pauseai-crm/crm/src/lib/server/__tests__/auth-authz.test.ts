import { beforeEach, describe, expect, it } from 'vitest'
import { useTestDb } from '../../../test/db'
import { bootstrapAdmins, redeemMagicLink, requestMagicLink, sessionFromToken, signOut } from '../auth'
import { buildActor } from '../authz/actor'
import { listVisiblePeople, maskPerson, tierFor } from '../authz/people'
import { createChapter, ensureGlobalChapter } from '../chapters'
import { accessGrants, teamMembers, teams } from '../db/schema'
import { resetEnvCache } from '../env'
import { sandboxOutbox } from '../integrations/mailersend/send'
import { ensureMembership, upsertPerson } from '../people'

const db = useTestDb()

beforeEach(() => {
	process.env.BOOTSTRAP_ADMIN_EMAILS = 'root@pauseai.info'
	process.env.AUTH_DEV_PRINT_LINKS = 'false'
	resetEnvCache()
	sandboxOutbox.length = 0
})

describe('magic link auth', () => {
	it('emails a link to known people, silently ignores unknown ones, and redeems once', async () => {
		await upsertPerson({ email: 'known@example.org', fullName: 'Known' }, undefined, db())
		await requestMagicLink('nobody@example.org', db())
		expect(sandboxOutbox).toHaveLength(0)
		await requestMagicLink('Known@Example.org', db())
		expect(sandboxOutbox).toHaveLength(1)
		const token = new URL(sandboxOutbox[0]!.text.match(/https?:\S+/)![0]).searchParams.get('token')!
		const session = await redeemMagicLink(token, 'test-agent', db())
		expect(session?.person.email).toBe('known@example.org')
		expect(await redeemMagicLink(token, null, db())).toBeNull()
		const resolved = await sessionFromToken(session!.sessionToken, db())
		expect(resolved?.person.id).toBe(session!.person.id)
		await signOut(session!.sessionToken, db())
		expect(await sessionFromToken(session!.sessionToken, db())).toBeNull()
	})

	it('bootstraps the configured admin on first sign-in', async () => {
		expect(bootstrapAdmins()).toEqual(['root@pauseai.info'])
		await requestMagicLink('root@pauseai.info', db())
		const token = new URL(sandboxOutbox[0]!.text.match(/https?:\S+/)![0]).searchParams.get('token')!
		const session = await redeemMagicLink(token, null, db())
		const actor = await buildActor(session!.person, db())
		expect(actor.isGlobalAdmin).toBe(true)
	})
})

describe('authorization scoping', () => {
	it('scopes people to chapter subtrees, teams and self', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id, country: 'United Kingdom' }, db())
		const bristol = await createChapter({ name: 'Bristol', kind: 'local', parentId: uk.id }, db())
		const de = await createChapter({ name: 'PauseAI Germany', kind: 'national', parentId: global.id, country: 'Germany' }, db())

		const admin = (await upsertPerson({ email: 'admin@example.org', fullName: 'Admin' }, undefined, db())).person
		const ukLead = (await upsertPerson({ email: 'uklead@example.org', fullName: 'UK Lead' }, undefined, db())).person
		const bristolVol = (await upsertPerson({ email: 'bristol@example.org', fullName: 'Bristol Vol', phone: '+44 1' }, undefined, db())).person
		const deVol = (await upsertPerson({ email: 'de@example.org', fullName: 'DE Vol' }, undefined, db())).person
		const teamLead = (await upsertPerson({ email: 'tl@example.org', fullName: 'Team Lead' }, undefined, db())).person

		await db().insert(accessGrants).values([
			{ personId: admin.id, role: 'global_admin' },
			{ personId: ukLead.id, role: 'chapter_admin', chapterId: uk.id }
		])
		await ensureMembership(ukLead.id, uk.id, { role: 'chapter_lead', status: 'active' }, db())
		await ensureMembership(bristolVol.id, bristol.id, { role: 'volunteer', status: 'active' }, db())
		await ensureMembership(deVol.id, de.id, { role: 'volunteer', status: 'active' }, db())
		const [team] = await db().insert(teams).values({ chapterId: de.id, slug: 'media', name: 'Media' }).returning()
		await db().insert(teamMembers).values([
			{ teamId: team!.id, personId: teamLead.id, role: 'lead' },
			{ teamId: team!.id, personId: deVol.id, role: 'member' }
		])

		const names = async (p: typeof admin) => (await listVisiblePeople(await buildActor(p, db()), {}, db())).map((x) => x.fullName).sort()
		expect(await names(admin)).toEqual(['Admin', 'Bristol Vol', 'DE Vol', 'Team Lead', 'UK Lead'])
		expect(await names(ukLead)).toEqual(['Bristol Vol', 'UK Lead'])
		expect(await names(bristolVol)).toEqual(['Bristol Vol'])
		expect(await names(teamLead)).toEqual(['DE Vol', 'Team Lead'])

		const ukActor = await buildActor(ukLead, db())
		expect(await tierFor(ukActor, bristolVol.id, db())).toBe('admin')
		expect(await tierFor(ukActor, deVol.id, db())).toBeNull()
		expect(await tierFor(ukActor, ukLead.id, db())).toBe('self')
		const tlActor = await buildActor(teamLead, db())
		expect(await tierFor(tlActor, deVol.id, db())).toBe('scoped')
		expect(maskPerson(bristolVol, 'scoped').phone).toBeNull()
		expect(maskPerson(bristolVol, 'admin').phone).toBe('+44 1')
	})
})
