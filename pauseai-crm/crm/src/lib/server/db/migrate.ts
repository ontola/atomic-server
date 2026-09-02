import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Db } from './client'

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../drizzle')

/** Apply all pending SQL migrations from ./drizzle. Safe to run repeatedly. */
export async function runMigrations(db: Db) {
	await migrate(db, { migrationsFolder })
}
