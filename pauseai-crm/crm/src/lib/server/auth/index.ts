// Passwordless sign-in. Email is the identity every PauseAI system already
// shares (Airtable, MailerSend, Substack), so a magic link needs no new
// account and no password to leak. Tokens and session ids are stored hashed.
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db as sharedDb, type Db } from '../db/client'
import { accessGrants, loginTokens, people, sessions } from '../db/schema'
import { env } from '../env'
import { sendEmail } from '../integrations/mailersend/send'
import { findByEmail, normalizeEmail, upsertPerson } from '../people'
import { ensureGlobalChapter } from '../chapters'

export const SESSION_COOKIE = 'crm_session'
const TOKEN_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export function hash(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

/**
 * Create a login token and email the link. Always returns normally for an
 * unknown email: the response must not reveal who is in the database.
 * Returns the link when AUTH_DEV_PRINT_LINKS is on, for local development.
 */
export async function requestMagicLink(rawEmail: string, db: Db = sharedDb()): Promise<{ link?: string }> {
	const email = normalizeEmail(rawEmail)
	if (!email) return {}
	const person = await findByEmail(email, db)
	const bootstrap = bootstrapAdmins().includes(email)
	if (!person && !bootstrap) return {}

	const token = randomBytes(32).toString('base64url')
	await db.insert(loginTokens).values({ tokenHash: hash(token), email, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) })
	const link = `${env().APP_ORIGIN}/login/verify?token=${token}`
	if (env().AUTH_DEV_PRINT_LINKS === 'true') {
		console.info(`[auth] magic link for ${email}: ${link}`)
		return { link }
	}
	await sendEmail({
		to: [{ email }],
		subject: 'Your PauseAI CRM sign-in link',
		text: `Sign in to the PauseAI CRM:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not request it, ignore this email.`,
		tags: ['auth']
	})
	return {}
}

/** Exchange a token for a session. Returns the raw session token to set as a cookie. */
export async function redeemMagicLink(token: string, userAgent: string | null, db: Db = sharedDb()) {
	const now = new Date()
	const [row] = await db
		.update(loginTokens)
		.set({ usedAt: now })
		.where(and(eq(loginTokens.tokenHash, hash(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, now)))
		.returning()
	if (!row) return null

	let person = await findByEmail(row.email, db)
	if (!person) {
		person = (await upsertPerson({ email: row.email, fullName: row.email.split('@')[0] ?? '', source: 'login' }, undefined, db)).person
	}
	if (bootstrapAdmins().includes(row.email)) await ensureGlobalAdmin(person.id, db)

	const sessionToken = randomBytes(32).toString('base64url')
	await db.insert(sessions).values({
		id: hash(sessionToken),
		personId: person.id,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS),
		userAgent: userAgent?.slice(0, 300) ?? null
	})
	return { sessionToken, person }
}

export async function sessionFromToken(sessionToken: string | undefined, db: Db = sharedDb()) {
	if (!sessionToken) return null
	const id = hash(sessionToken)
	const session = await db.query.sessions.findFirst({ where: and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())) })
	if (!session) return null
	const person = await db.query.people.findFirst({ where: and(eq(people.id, session.personId), isNull(people.deletedAt)) })
	if (!person) return null
	// Touch at most once an hour to keep the write load negligible.
	if (Date.now() - session.lastUsedAt.getTime() > 3600 * 1000) {
		await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, id))
	}
	return { session, person }
}

export async function signOut(sessionToken: string | undefined, db: Db = sharedDb()) {
	if (!sessionToken) return
	await db.delete(sessions).where(eq(sessions.id, hash(sessionToken)))
}

export function bootstrapAdmins(): string[] {
	return env()
		.BOOTSTRAP_ADMIN_EMAILS.split(',')
		.map((e) => normalizeEmail(e))
		.filter((e): e is string => Boolean(e))
}

export async function ensureGlobalAdmin(personId: string, db: Db = sharedDb()) {
	await ensureGlobalChapter(db)
	const existing = await db.query.accessGrants.findFirst({
		where: and(eq(accessGrants.personId, personId), eq(accessGrants.role, 'global_admin'))
	})
	if (!existing) await db.insert(accessGrants).values({ personId, role: 'global_admin' })
}

export function sessionCookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: env().NODE_ENV === 'production',
		maxAge: SESSION_TTL_MS / 1000
	}
}
