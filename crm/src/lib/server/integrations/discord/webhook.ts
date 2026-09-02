// Inbound events from PauseBot. PauseBot signs each request with
// HMAC-SHA256 over `<timestamp>.<raw body>` using the shared secret; we check
// the signature and reject anything older than five minutes.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SIGNATURE_HEADER = 'x-pausebot-signature'
export const TIMESTAMP_HEADER = 'x-pausebot-timestamp'
const MAX_SKEW_SECONDS = 300

export function sign(secret: string, timestamp: string, body: string): string {
	return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export function verifySignature(
	secret: string,
	headers: { signature: string | null; timestamp: string | null },
	body: string,
	now = Date.now()
): VerifyResult {
	if (!headers.signature || !headers.timestamp) return { ok: false, reason: 'missing signature headers' }
	const ts = Number(headers.timestamp)
	if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' }
	if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside allowed window' }
	const expected = Buffer.from(sign(secret, headers.timestamp, body), 'hex')
	const given = Buffer.from(headers.signature.replace(/^sha256=/, ''), 'hex')
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature mismatch' }
	return { ok: true }
}

const member = z.object({
	id: z.string().min(1),
	username: z.string().min(1),
	global_name: z.string().nullable().optional(),
	nick: z.string().nullable().optional(),
	joined_at: z.string().nullable().optional(),
	role_ids: z.array(z.string()).default([])
})

export const pausebotEvent = z.discriminatedUnion('type', [
	z.object({ id: z.string().min(1), type: z.literal('member.joined'), at: z.string(), member }),
	z.object({ id: z.string().min(1), type: z.literal('member.roles_updated'), at: z.string(), member, added_role_ids: z.array(z.string()).default([]), removed_role_ids: z.array(z.string()).default([]) }),
	z.object({ id: z.string().min(1), type: z.literal('member.left'), at: z.string(), member })
])

export type PausebotEvent = z.infer<typeof pausebotEvent>
export type DiscordMember = z.infer<typeof member>
