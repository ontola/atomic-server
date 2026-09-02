// Background worker: `pnpm worker`. Runs the job queue and the recurring
// schedule. One instance is enough; more are safe.
import 'dotenv/config'
import { createDb } from './lib/server/db/client'
import { runMigrations } from './lib/server/db/migrate'
import { scheduleRecurring } from './lib/server/jobs/handlers'
import { releaseStale, workLoop } from './lib/server/jobs/queue'

const db = createDb(undefined, { max: 3 })
await runMigrations(db)
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())

const tick = async () => {
	try {
		await releaseStale(undefined, db)
		await scheduleRecurring(new Date(), db)
	} catch (error) {
		console.error('[worker] schedule tick failed', error)
	}
}
await tick()
const timer = setInterval(tick, 5 * 60 * 1000)
console.info('[worker] started')
await workLoop({ signal: controller.signal }, db)
clearInterval(timer)
console.info('[worker] stopped')
process.exit(0)
