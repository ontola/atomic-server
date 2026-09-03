// Receives signed events from PauseBot. Stores first, processes second, so a
// crash mid-way never loses an event and a retry never double-applies one.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$server/env'
import { handlePausebotEvent, markProcessed, recordEvent } from '$server/integrations/discord/handlers'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, pausebotEvent, verifySignature } from '$server/integrations/discord/webhook'

export const POST: RequestHandler = async ({ request }) => {
	const secret = env().PAUSEBOT_WEBHOOK_SECRET
	if (!secret) return json({ error: 'webhook not configured' }, { status: 503 })
	const body = await request.text()
	const verdict = verifySignature(secret, { signature: request.headers.get(SIGNATURE_HEADER), timestamp: request.headers.get(TIMESTAMP_HEADER) }, body)
	if (!verdict.ok) return json({ error: verdict.reason }, { status: 401 })

	let parsed
	try {
		parsed = pausebotEvent.parse(JSON.parse(body))
	} catch (error) {
		return json({ error: 'invalid event', details: error instanceof Error ? error.message : String(error) }, { status: 400 })
	}
	const fresh = await recordEvent(parsed)
	if (!fresh) return json({ ok: true, duplicate: true })
	try {
		await handlePausebotEvent(parsed)
		await markProcessed(parsed.id)
		return json({ ok: true })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await markProcessed(parsed.id, message)
		return json({ error: 'processing failed', details: message }, { status: 500 })
	}
}
