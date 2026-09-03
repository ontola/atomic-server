// Seed a database with the global chapter, the built-in project templates and
// (optionally) a first admin. Idempotent.
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/lib/server/db/client'
import { projectTemplates } from '../src/lib/server/db/schema'
import { ensureGlobalChapter } from '../src/lib/server/chapters'
import { BUILT_IN_TEMPLATES } from '../src/lib/server/tasks/templates'
import { bootstrapAdmins, ensureGlobalAdmin } from '../src/lib/server/auth'
import { upsertPerson } from '../src/lib/server/people'

const db = createDb(undefined, { max: 1 })
await ensureGlobalChapter(db)
for (const t of BUILT_IN_TEMPLATES) {
	const existing = await db.query.projectTemplates.findFirst({ where: eq(projectTemplates.slug, t.slug) })
	if (existing) {
		await db.update(projectTemplates).set({ name: t.name, kind: t.kind, description: t.description, defaultDurationDays: t.defaultDurationDays, steps: t.steps, updatedAt: new Date() }).where(eq(projectTemplates.id, existing.id))
	} else {
		await db.insert(projectTemplates).values(t)
	}
}
for (const email of bootstrapAdmins()) {
	const { person } = await upsertPerson({ email, fullName: email.split('@')[0] ?? '', source: 'seed' }, undefined, db)
	await ensureGlobalAdmin(person.id, db)
	console.log(`global_admin: ${email}`)
}
console.log(`Seeded ${BUILT_IN_TEMPLATES.length} templates.`)
process.exit(0)
