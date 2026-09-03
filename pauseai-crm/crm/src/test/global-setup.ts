// Vitest global setup: point the app at a scratch database, create it if
// needed and apply the migrations once for the whole run. Individual tests
// truncate what they touch (see test/db.ts).
import postgres from 'postgres'

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/pauseai_crm_test'

export default async function setup() {
	const url = new URL(base)
	const dbName = url.pathname.slice(1)
	const admin = postgres({ ...connectionOptions(url), database: 'postgres', max: 1 })
	const exists = await admin`select 1 from pg_database where datname = ${dbName}`
	if (exists.length === 0) await admin.unsafe(`create database "${dbName}"`)
	await admin.end()

	process.env.DATABASE_URL = base
	process.env.EMAIL_MODE = 'sandbox'
	process.env.PAUSEBOT_WEBHOOK_SECRET = 'test-secret'
	const { createDb } = await import('../lib/server/db/client')
	const { runMigrations } = await import('../lib/server/db/migrate')
	const db = createDb(base, { max: 1 })
	await runMigrations(db)
	await (db as unknown as { $client: postgres.Sql }).$client.end()
}

function connectionOptions(url: URL) {
	return {
		host: url.hostname,
		port: Number(url.port || 5432),
		username: decodeURIComponent(url.username || 'postgres'),
		password: decodeURIComponent(url.password || '')
	}
}
