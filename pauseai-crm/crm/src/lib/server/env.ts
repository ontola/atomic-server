// Runtime configuration. Read once, validated once, so a misconfigured deploy
// fails at boot rather than on the first request that needs a secret.
import { z } from 'zod'

const schema = z.object({
	DATABASE_URL: z.string().url().default('postgres://postgres@127.0.0.1:54329/pauseai_crm'),
	/** Public origin of this deployment, used in magic links and unsubscribe links. */
	APP_ORIGIN: z.string().url().default('http://localhost:5173'),
	/** `sandbox` writes outbound email to the log and the `interactions` table without sending. */
	EMAIL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
	MAILERSEND_API_KEY: z.string().optional(),
	EMAIL_FROM: z.string().default('CRM <crm@pauseai.info>'),

	AIRTABLE_API_KEY: z.string().optional(),
	/** "PauseAI Volunteers & Actions" base. */
	AIRTABLE_BASE_ID: z.string().default('appWPTGqZmUcs3NWu'),
	AIRTABLE_MEMBERS_TABLE_ID: z.string().default('tblL1icZBhTV1gQ9o'),
	AIRTABLE_CHAPTERS_TABLE_ID: z.string().default('tblEQJ26hxBAEkaP8'),

	/** Shared secret PauseBot signs its webhooks with. */
	PAUSEBOT_WEBHOOK_SECRET: z.string().optional(),
	/** Base URL of the running PauseBot, for outbound role assignment. */
	PAUSEBOT_URL: z.string().url().optional(),
	PAUSEBOT_API_SECRET: z.string().optional(),

	/** Comma-separated emails that are granted global_admin on first login. */
	BOOTSTRAP_ADMIN_EMAILS: z.string().default(''),
	/** Development only: skip email and print the magic link to the console. */
	AUTH_DEV_PRINT_LINKS: z.enum(['true', 'false']).default('false'),
	NODE_ENV: z.string().default('development')
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function env(): Env {
	if (!cached) {
		const parsed = schema.safeParse(process.env)
		if (!parsed.success) {
			throw new Error(`Invalid environment: ${parsed.error.message}`)
		}
		cached = parsed.data
	}
	return cached
}

/** Test helper: forget the cached environment so a test can override variables. */
export function resetEnvCache() {
	cached = undefined
}
