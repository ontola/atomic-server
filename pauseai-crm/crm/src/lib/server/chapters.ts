// Chapter tree: PauseAI Global at the root, national chapters below it, local
// groups below those. The materialized `path` column makes subtree queries a
// prefix match, which is what authorization scoping needs on every request.
import { and, eq, like, or, sql } from 'drizzle-orm'
import { db as sharedDb, type Db } from './db/client'
import { chapters, type Chapter } from './db/schema'

export const GLOBAL_SLUG = 'global'

export function slugify(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
}

export type NewChapterInput = {
	name: string
	kind: 'global' | 'national' | 'local'
	slug?: string
	parentId?: string | null
	country?: string | null
	region?: string | null
	latitude?: number | null
	longitude?: number | null
	email?: string | null
	discordRoleId?: string | null
	discordChannelId?: string | null
	whatsappUrl?: string | null
	websiteUrl?: string | null
	airtableRecordId?: string | null
	active?: boolean
}

/** Insert a chapter and compute its path from the parent. The root has no parent. */
export async function createChapter(input: NewChapterInput, db: Db = sharedDb()): Promise<Chapter> {
	const slug = input.slug ?? slugify(input.name)
	let path = `/${slug}`
	if (input.parentId) {
		const parent = await db.query.chapters.findFirst({ where: eq(chapters.id, input.parentId) })
		if (!parent) throw new Error(`Parent chapter ${input.parentId} not found`)
		path = `${parent.path}/${slug}`
	} else if (input.kind !== 'global') {
		throw new Error('Only the global chapter may have no parent')
	}
	const [row] = await db
		.insert(chapters)
		.values({ ...input, slug, path, parentId: input.parentId ?? null })
		.returning()
	if (!row) throw new Error('Insert returned no row')
	return row
}

/** The root chapter, created on first use so a fresh database is usable immediately. */
export async function ensureGlobalChapter(db: Db = sharedDb()): Promise<Chapter> {
	const existing = await db.query.chapters.findFirst({ where: eq(chapters.slug, GLOBAL_SLUG) })
	if (existing) return existing
	return createChapter({ name: 'PauseAI Global', kind: 'global', slug: GLOBAL_SLUG }, db)
}

/** The chapter itself plus everything below it. */
export async function chapterSubtree(chapterId: string, db: Db = sharedDb()): Promise<Chapter[]> {
	const root = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) })
	if (!root) return []
	return db
		.select()
		.from(chapters)
		.where(or(eq(chapters.id, root.id), like(chapters.path, `${root.path}/%`)))
}

/** SQL fragment: "chapter with this path is within any of these subtree roots". */
export function withinSubtrees(paths: string[]) {
	if (paths.length === 0) return sql`false`
	return or(...paths.map((p) => or(eq(chapters.path, p), like(chapters.path, `${p}/%`))))!
}

/**
 * Route a signup to a chapter. National match on the Airtable country name;
 * within a country, the nearest active local group within `maxKm` when we have
 * coordinates for both. Falls back to Global when nothing matches, which is
 * also where the onboarding team lives.
 */
export async function routeToChapter(
	input: { country?: string | null; latitude?: number | null; longitude?: number | null },
	options: { maxKm?: number } = {},
	db: Db = sharedDb()
): Promise<Chapter> {
	const maxKm = options.maxKm ?? 80
	const global = await ensureGlobalChapter(db)
	if (!input.country) return global
	const national = await db.query.chapters.findFirst({
		where: and(
			eq(chapters.kind, 'national'),
			eq(chapters.active, true),
			sql`lower(${chapters.country}) = lower(${input.country})`
		)
	})
	if (!national) return global
	if (input.latitude == null || input.longitude == null) return national
	const locals = await db
		.select()
		.from(chapters)
		.where(
			and(
				eq(chapters.kind, 'local'),
				eq(chapters.active, true),
				like(chapters.path, `${national.path}/%`),
				sql`${chapters.latitude} is not null and ${chapters.longitude} is not null`
			)
		)
	let best: { chapter: Chapter; km: number } | undefined
	for (const local of locals) {
		const km = haversineKm(input.latitude, input.longitude, local.latitude!, local.longitude!)
		if (km <= maxKm && (!best || km < best.km)) best = { chapter: local, km }
	}
	return best?.chapter ?? national
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = 6371
	const toRad = (d: number) => (d * Math.PI) / 180
	const dLat = toRad(lat2 - lat1)
	const dLon = toRad(lon2 - lon1)
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
	return 2 * r * Math.asin(Math.sqrt(a))
}
