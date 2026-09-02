import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>

export function createDb(url = env().DATABASE_URL, options: { max?: number } = {}) {
	const client = postgres(url, {
		max: options.max ?? 10,
		// Keep the pool small and idle connections short: this runs on cheap hosts.
		idle_timeout: 20,
		connect_timeout: 10,
		// Migrations emit "already exists, skipping" notices; keep logs clean.
		onnotice: () => {}
	})
	return drizzle(client, { schema })
}

let shared: Db | undefined

/** The process-wide database handle. Created lazily so tests can point it elsewhere. */
export function db(): Db {
	if (!shared) shared = createDb()
	return shared
}

/** Replace the shared handle (tests, or a worker that wants a dedicated pool). */
export function setDb(next: Db | undefined) {
	shared = next
}

export { schema }
