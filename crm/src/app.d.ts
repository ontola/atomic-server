import type { Actor } from '$server/authz/actor'

declare global {
	namespace App {
		interface Locals {
			/** The authenticated person and their effective grants, or null when signed out. */
			actor: Actor | null
			/** Session id, when signed in. */
			sessionId: string | null
		}
		interface Error {
			message: string
		}
	}
}

export {}
