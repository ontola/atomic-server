import { createDb } from '../src/lib/server/db/client'
import { runMigrations } from '../src/lib/server/db/migrate'

const db = createDb(undefined, { max: 1 })
await runMigrations(db)
console.log('Migrations applied.')
process.exit(0)
