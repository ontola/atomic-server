// Outbound calls to PauseBot's small web API (PauseBot main.py: /webhook/add_role).
import { env } from '../../env'

export async function assignDiscordRole(discordUserId: string, roleId: string, fetchImpl: typeof fetch = fetch) {
	const { PAUSEBOT_URL, PAUSEBOT_API_SECRET } = env()
	if (!PAUSEBOT_URL || !PAUSEBOT_API_SECRET) throw new Error('PAUSEBOT_URL and PAUSEBOT_API_SECRET are required to assign roles')
	const response = await fetchImpl(new URL('/webhook/add_role', PAUSEBOT_URL), {
		method: 'POST',
		headers: { Authorization: `Bearer ${PAUSEBOT_API_SECRET}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: discordUserId, role_id: roleId })
	})
	if (!response.ok) throw new Error(`PauseBot add_role ${response.status}: ${(await response.text()).slice(0, 300)}`)
	return (await response.json()) as { success: boolean; message?: string }
}
