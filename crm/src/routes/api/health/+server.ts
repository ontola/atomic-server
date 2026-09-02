import { json } from '@sveltejs/kit'
import { sql } from 'drizzle-orm'
import type { RequestHandler } from './$types'
import { db } from '$server/db/client'

export const GET: RequestHandler = async () => {
	try {
		await db().execute(sql`select 1`)
		return json({ status: 'ok' })
	} catch (error) {
		return json({ status: 'degraded', error: error instanceof Error ? error.message : String(error) }, { status: 503 })
	}
}
