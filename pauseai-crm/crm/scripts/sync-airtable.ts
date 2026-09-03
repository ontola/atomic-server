// One-off Airtable import: `pnpm sync:airtable [--full] [--limit N]`.
import 'dotenv/config'
import { createDb } from '../src/lib/server/db/client'
import { runMigrations } from '../src/lib/server/db/migrate'
import { runAirtableSync } from '../src/lib/server/sync/airtable'

const args = process.argv.slice(2)
const full = args.includes('--full')
const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined
const db = createDb(undefined, { max: 2 })
await runMigrations(db)
const report = await runAirtableSync({ full, limit }, db)
for (const r of [report.chapters, report.members]) {
	console.log(`${r.source}: scanned ${r.scanned}, created ${r.created}, updated ${r.updated}, skipped ${r.skipped}, errors ${r.errors.length}`)
	for (const [field, values] of Object.entries(r.drift)) console.log(`  drift in ${field}: ${[...values].join(' | ')}`)
	for (const e of r.errors.slice(0, 10)) console.log(`  error ${e.recordId}: ${e.message}`)
}
process.exit(0)
