// Fill a database with realistic demo data so the app can be explored without
// Airtable or Discord: chapters, people of every kind, consents, a running
// project with an overdue task, and some webhook and job history.
// Usage: DATABASE_URL=... BOOTSTRAP_ADMIN_EMAILS=you@example.org pnpm demo:data
import 'dotenv/config'
import { createDb } from '../src/lib/server/db/client'
import { runMigrations } from '../src/lib/server/db/migrate'
import { accessGrants, journalistProfiles, jobs, politicianProfiles, projectTemplates, tasks, teamMembers, teams, webhookEvents } from '../src/lib/server/db/schema'
import { createChapter, ensureGlobalChapter } from '../src/lib/server/chapters'
import { ensureMembership, linkIdentity, logInteraction, recordConsent, upsertPerson, upsertVolunteerProfile } from '../src/lib/server/people'
import { instantiateTemplate } from '../src/lib/server/tasks'
import { BUILT_IN_TEMPLATES } from '../src/lib/server/tasks/templates'
import { bootstrapAdmins, ensureGlobalAdmin } from '../src/lib/server/auth'
import { eq } from 'drizzle-orm'

const db = createDb(undefined, { max: 2 })
await runMigrations(db)
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)

const global = await ensureGlobalChapter(db)
for (const t of BUILT_IN_TEMPLATES) {
	const existing = await db.query.projectTemplates.findFirst({ where: eq(projectTemplates.slug, t.slug) })
	if (!existing) await db.insert(projectTemplates).values(t)
}

const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id, country: 'United Kingdom', email: 'uk@pauseai.info', discordRoleId: '1188719374941560925', latitude: 52.5, longitude: -1.5 }, db)
const bristol = await createChapter({ name: 'Bristol', kind: 'local', parentId: uk.id, country: 'United Kingdom', latitude: 51.4545, longitude: -2.5879, whatsappUrl: 'https://chat.whatsapp.com/example' }, db)
const london = await createChapter({ name: 'London', kind: 'local', parentId: uk.id, country: 'United Kingdom', latitude: 51.5074, longitude: -0.1278 }, db)
const de = await createChapter({ name: 'PauseAI Germany', kind: 'national', parentId: global.id, country: 'Germany', email: 'germany@pauseai.info', discordRoleId: '1188719399117541396' }, db)
const nl = await createChapter({ name: 'PauseAI Netherlands', kind: 'national', parentId: global.id, country: 'Netherlands', discordRoleId: '1188719443954643035' }, db)
const [media] = await db.insert(teams).values({ chapterId: uk.id, slug: 'media', name: 'Media team' }).returning()

const person = async (p: Parameters<typeof upsertPerson>[0]) => (await upsertPerson(p, undefined, db)).person

for (const email of bootstrapAdmins()) {
	const me = await person({ email, fullName: 'Joep Meindertsma', country: 'Netherlands', city: 'Utrecht', kinds: ['volunteer'] })
	await ensureGlobalAdmin(me.id, db)
	await ensureMembership(me.id, global.id, { role: 'chapter_lead', status: 'active', source: 'demo' }, db)
}

const harry = await person({ email: 'harry@example.org', fullName: 'Harry Turnbull', country: 'United Kingdom', city: 'Bristol', phone: '+44 7700 900001', languages: ['English'], kinds: ['volunteer'], airtableRecordId: 'recDEMO0000000001', source: 'June 2026 onboarding flow' })
await db.insert(accessGrants).values({ personId: harry.id, role: 'chapter_admin', chapterId: uk.id })
await ensureMembership(harry.id, uk.id, { role: 'chapter_lead', status: 'active', source: 'airtable:members' }, db)
await ensureMembership(harry.id, bristol.id, { role: 'chapter_lead', status: 'active', source: 'demo' }, db)
await upsertVolunteerProfile(harry.id, { intent: 'Lead', weeklyHours: '10-20 hours', skills: ['Community Organizing', 'Public Speaking/ Presentation'], motivations: ['AI Safety'], stage: 'highly_active' }, db)
await linkIdentity(harry.id, { provider: 'discord', externalId: '335365981276995594', handle: 'hturnbull', verified: true }, db)
await linkIdentity(harry.id, { provider: 'airtable', externalId: 'recDEMO0000000001' }, db)

const volunteers = [
	{ email: 'amina@example.org', fullName: 'Amina Osei', city: 'Bristol', chapter: bristol, hours: '3-6 hours', skills: ['Writing', 'Social Media Management'], stage: 'active' as const, discord: 'amina.o' },
	{ email: 'tom@example.org', fullName: 'Tom Whitfield', city: 'Bath', chapter: bristol, hours: 'Less than 3 hours', skills: ['Video Creation'], stage: 'onboarding' as const, discord: null },
	{ email: 'priya@example.org', fullName: 'Priya Natarajan', city: 'London', chapter: london, hours: '6-10 hours', skills: ['Research', 'Political Advocacy/ Lobbying'], stage: 'active' as const, discord: 'priya_n' },
	{ email: 'lukas@example.org', fullName: 'Lukas Brandt', city: 'Berlin', chapter: de, hours: '3-6 hours', skills: ['Event Organization'], stage: 'active' as const, discord: 'lukasb' },
	{ email: 'sanne@example.org', fullName: 'Sanne de Vries', city: 'Utrecht', chapter: nl, hours: '6-10 hours', skills: ['Graphic Design/ Visual Arts'], stage: 'dormant' as const, discord: null }
]
const people: Record<string, { id: string }> = {}
for (const [index, v] of volunteers.entries()) {
	const p = await person({ email: v.email, fullName: v.fullName, country: v.chapter.country, city: v.city, languages: ['English'], kinds: ['volunteer'], source: 'June 2026 onboarding flow', sourcePage: 'pauseai.info/join' })
	people[v.email] = p
	await ensureMembership(p.id, v.chapter.id, { role: 'volunteer', status: v.stage === 'onboarding' ? 'onboarding' : v.stage === 'dormant' ? 'dormant' : 'active', source: 'airtable:members' }, db)
	if (v.chapter.kind === 'local') await ensureMembership(p.id, uk.id, { role: 'volunteer', status: 'active', source: 'discord' }, db)
	await upsertVolunteerProfile(p.id, { intent: 'Volunteer', weeklyHours: v.hours, skills: v.skills, motivations: ['AI Safety', 'Concentration of power'], discovery: 'Friend/Family referral', stage: v.stage }, db)
	for (const purpose of ['privacy_policy', 'volunteer_agreement', 'code_of_conduct', 'chapter_share'] as const) await recordConsent(p.id, purpose, true, 'join-form', {}, db)
	await recordConsent(p.id, 'newsletter', v.email !== 'tom@example.org', 'join-form', {}, db)
	if (v.discord) await linkIdentity(p.id, { provider: 'discord', externalId: `70000000000000${1000 + index}`, handle: v.discord, verified: true }, db)
	await logInteraction({ personId: p.id, kind: 'email_sent', channel: 'email', subject: 'Welcome to PauseAI', occurredAt: ago(20), externalRef: `demo:welcome:${v.email}` }, db)
	if (v.discord) await logInteraction({ personId: p.id, kind: 'action_completed', channel: 'discord', subject: 'Joined the PauseAI Discord', occurredAt: ago(18), externalRef: `demo:discord:${v.email}` }, db)
}
await db.insert(teamMembers).values([{ teamId: media!.id, personId: people['amina@example.org']!.id, role: 'lead' }, { teamId: media!.id, personId: people['priya@example.org']!.id, role: 'member' }])
await logInteraction({ personId: people['amina@example.org']!.id, kind: 'event_attended', channel: 'in_person', subject: 'Bristol screening night, August', occurredAt: ago(9), chapterId: bristol.id, visibility: 'team' }, db)
await logInteraction({ personId: people['amina@example.org']!.id, kind: 'action_completed', channel: 'web', subject: 'Emailed her MP about the Frontier AI letter', occurredAt: ago(8), visibility: 'team' }, db)
await logInteraction({ personId: people['tom@example.org']!.id, kind: 'note', subject: 'Keen but new; pair him with Amina for the next event', occurredAt: ago(3), actorPersonId: harry.id, chapterId: bristol.id, visibility: 'leads' }, db)

const mp = await person({ fullName: 'Rt Hon. Jane Example MP', email: 'jane.example.mp@parliament.uk', country: 'United Kingdom', city: 'Bristol', kinds: ['politician'] })
await db.insert(politicianProfiles).values({ personId: mp.id, level: 'national', body: 'House of Commons', party: 'Labour', constituency: 'Bristol Central', stance: 'contacted', surgeryInfo: 'First Friday of the month, 16:00 to 18:00, Bristol constituency office (book by email)', parliamentId: '4000' })
await logInteraction({ personId: mp.id, kind: 'email_sent', channel: 'email', subject: 'Frontier AI open letter sent via the website tool', occurredAt: ago(30), externalRef: 'demo:mp:1' }, db)
await logInteraction({ personId: mp.id, kind: 'meeting', channel: 'in_person', subject: 'Surgery visit with three constituents; asked for support on the pause motion', occurredAt: ago(6), actorPersonId: harry.id, chapterId: bristol.id }, db)
await logInteraction({ personId: mp.id, kind: 'statement', channel: 'parliament', subject: 'Asked a written question on frontier model evaluations', occurredAt: ago(2), externalRef: 'demo:hansard:1' }, db)

const journalist = await person({ fullName: 'Sam Reporter', email: 'sam@example-news.co.uk', country: 'United Kingdom', city: 'London', kinds: ['journalist'] })
await db.insert(journalistProfiles).values({ personId: journalist.id, outlet: 'Example News', beat: 'Technology', region: 'UK', stance: 'covered' })
await logInteraction({ personId: journalist.id, kind: 'press_mention', channel: 'press', subject: 'Quoted PauseAI UK in a piece on the AI bill', occurredAt: ago(12) }, db)

const eventDay = new Date(Date.now() + 12 * DAY)
const { tasks: created } = await instantiateTemplate({ templateSlug: 'watch-party-and-emails', chapterId: bristol.id, name: 'Bristol screening night, September', ownerPersonId: people['amina@example.org']!.id, teamId: media!.id, dueAt: eventDay, assignedBy: harry.id }, db)
// One task already done, one overdue and reminded (ready to escalate on the next sweep).
await db.update(tasks).set({ status: 'done', completedAt: ago(4) }).where(eq(tasks.id, created.find((t) => t.templateStepKey === 'venue')!.id))
await db.update(tasks).set({ ownerPersonId: people['tom@example.org']!.id, dueAt: ago(3), remindedAt: ago(5), updatedAt: ago(6) }).where(eq(tasks.id, created.find((t) => t.templateStepKey === 'videos')!.id))
await instantiateTemplate({ templateSlug: 'volunteer-onboarding', chapterId: bristol.id, name: 'Onboard Tom Whitfield', ownerPersonId: harry.id, startsAt: ago(2), assignedBy: harry.id }, db)

await db.insert(webhookEvents).values([
	{ source: 'pausebot', externalId: 'demo-1', payload: { type: 'member.joined', member: { username: 'amina.o' } }, receivedAt: ago(18), processedAt: ago(18) },
	{ source: 'pausebot', externalId: 'demo-2', payload: { type: 'member.roles_updated', member: { username: 'amina.o' } }, receivedAt: ago(17), processedAt: ago(17) }
])
await db.insert(jobs).values([
	{ kind: 'airtable.sync', status: 'done', runAt: ago(0.1), finishedAt: ago(0.09), attempts: 1 },
	{ kind: 'tasks.deadline_sweep', status: 'done', runAt: ago(0.05), finishedAt: ago(0.04), attempts: 1 }
])
console.log('Demo data ready: 5 chapters, 9 people, 2 projects.')
process.exit(0)
