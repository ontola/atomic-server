// Outbound email. Every message the CRM sends goes through `sendEmail`, so the
// sandbox switch, the interaction log and the rate limiting have one home.
import { env } from '../../env'

export type OutboundEmail = {
	to: { email: string; name?: string }[]
	subject: string
	text: string
	html?: string
	replyTo?: string
	/** Free-form tags MailerSend keeps with the message, useful for analytics. */
	tags?: string[]
}

export type SendResult = { mode: 'sandbox' | 'live'; messageId: string | null }

/** In-memory record of sandboxed sends, for tests and the dev inbox page. */
export const sandboxOutbox: (OutboundEmail & { at: Date })[] = []

export async function sendEmail(mail: OutboundEmail, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
	const { EMAIL_MODE, MAILERSEND_API_KEY, EMAIL_FROM } = env()
	if (EMAIL_MODE !== 'live') {
		sandboxOutbox.push({ ...mail, at: new Date() })
		if (sandboxOutbox.length > 500) sandboxOutbox.shift()
		console.info(`[email:sandbox] to=${mail.to.map((t) => t.email).join(',')} subject=${JSON.stringify(mail.subject)}`)
		return { mode: 'sandbox', messageId: null }
	}
	if (!MAILERSEND_API_KEY) throw new Error('EMAIL_MODE=live requires MAILERSEND_API_KEY')
	const from = parseFrom(EMAIL_FROM)
	const response = await fetchImpl('https://api.mailersend.com/v1/email', {
		method: 'POST',
		headers: { Authorization: `Bearer ${MAILERSEND_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			from,
			to: mail.to,
			subject: mail.subject,
			text: mail.text,
			html: mail.html,
			reply_to: mail.replyTo ? { email: mail.replyTo } : undefined,
			tags: mail.tags
		})
	})
	if (!response.ok) {
		throw new Error(`MailerSend ${response.status}: ${(await response.text()).slice(0, 500)}`)
	}
	return { mode: 'live', messageId: response.headers.get('x-message-id') }
}

export function parseFrom(value: string): { email: string; name?: string } {
	const match = value.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/)
	if (match) return { name: match[1]?.trim() || undefined, email: match[2]!.trim() }
	return { email: value.trim() }
}
