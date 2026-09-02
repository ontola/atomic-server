// Per-test database helpers. `resetDb()` empties every application table so
// each test starts from a known state without re-running migrations.
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach } from 'vitest'
import { createDb, setDb, type Db } from '../lib/server/db/client'

const TABLES = [
	'audit_log',
	'webhook_events',
	'sync_sources',
	'jobs',
	'login_tokens',
	'sessions',
	'tasks',
	'projects',
	'project_templates',
	'interactions',
	'event_attendance',
	'events',
	'consents',
	'access_grants',
	'team_members',
	'memberships',
	'journalist_profiles',
	'politician_profiles',
	'volunteer_profiles',
	'identities',
	'people',
	'teams',
	'chapters'
]

let testDb: Db | undefined

export function useTestDb(): () => Db {
	beforeEach(async () => {
		if (!testDb) {
			testDb = createDb(process.env.DATABASE_URL, { max: 2 })
			setDb(testDb)
		}
		await resetDb(testDb)
	})
	afterAll(async () => {
		if (testDb) {
			await (testDb as unknown as { $client: { end: () => Promise<void> } }).$client.end()
			testDb = undefined
			setDb(undefined)
		}
	})
	return () => {
		if (!testDb) throw new Error('useTestDb: database not initialised yet')
		return testDb
	}
}

export async function resetDb(db: Db) {
	await db.execute(sql.raw(`truncate table ${TABLES.map((t) => `"${t}"`).join(', ')} cascade`))
}
