// Minimal Airtable REST client: paging, the 5 requests/second budget, retries
// on 429. Built on fetch so tests can inject responses without a network.
export type AirtableRecord<T = Record<string, unknown>> = { id: string; createdTime: string; fields: T }

export type ListOptions = {
	filterByFormula?: string
	fields?: string[]
	pageSize?: number
	view?: string
	/** Stop after this many records (for smoke tests). */
	limit?: number
}

export class AirtableClient {
	constructor(
		private apiKey: string,
		private fetchImpl: typeof fetch = fetch,
		private minIntervalMs = 210
	) {}

	private lastRequestAt = 0

	private async throttle() {
		const wait = this.lastRequestAt + this.minIntervalMs - Date.now()
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
		this.lastRequestAt = Date.now()
	}

	async request<T>(path: string, params: Record<string, string | string[] | undefined> = {}): Promise<T> {
		const url = new URL(`https://api.airtable.com/v0/${path}`)
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue
			if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(`${key}[]`, v))
			else url.searchParams.set(key, value)
		}
		for (let attempt = 1; ; attempt++) {
			await this.throttle()
			const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.apiKey}` } })
			if (response.status === 429 && attempt < 5) {
				const retryAfter = Number(response.headers.get('Retry-After') ?? '1')
				await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000))
				continue
			}
			if (!response.ok) {
				throw new Error(`Airtable ${response.status} for ${path}: ${(await response.text()).slice(0, 300)}`)
			}
			return (await response.json()) as T
		}
	}

	/** Iterate over all records in a table, following `offset` until Airtable stops returning one. */
	async *list<T = Record<string, unknown>>(
		baseId: string,
		tableId: string,
		options: ListOptions = {}
	): AsyncGenerator<AirtableRecord<T>> {
		let offset: string | undefined
		let yielded = 0
		do {
			const page = await this.request<{ records: AirtableRecord<T>[]; offset?: string }>(`${baseId}/${tableId}`, {
				filterByFormula: options.filterByFormula,
				fields: options.fields,
				pageSize: String(options.pageSize ?? 100),
				view: options.view,
				offset
			})
			for (const record of page.records) {
				yield record
				if (options.limit && ++yielded >= options.limit) return
			}
			offset = page.offset
		} while (offset)
	}
}
