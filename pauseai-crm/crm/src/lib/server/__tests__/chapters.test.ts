import { describe, expect, it } from 'vitest'
import { useTestDb } from '../../../test/db'
import { chapterSubtree, createChapter, ensureGlobalChapter, haversineKm, routeToChapter, slugify } from '../chapters'

const db = useTestDb()

describe('chapters', () => {
	it('builds materialized paths from the parent', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id, country: 'United Kingdom' }, db())
		const bristol = await createChapter({ name: 'Bristol', kind: 'local', parentId: uk.id }, db())
		expect(global.path).toBe('/global')
		expect(uk.path).toBe('/global/pauseai-uk')
		expect(bristol.path).toBe('/global/pauseai-uk/bristol')
		const subtree = await chapterSubtree(uk.id, db())
		expect(subtree.map((c) => c.slug).sort()).toEqual(['bristol', 'pauseai-uk'])
	})

	it('refuses a second root', async () => {
		await ensureGlobalChapter(db())
		await expect(createChapter({ name: 'Rogue', kind: 'national' }, db())).rejects.toThrow(/global/)
	})

	it('routes by country, then by distance to a local group, else global', async () => {
		const global = await ensureGlobalChapter(db())
		const uk = await createChapter({ name: 'PauseAI UK', kind: 'national', parentId: global.id, country: 'United Kingdom' }, db())
		const bristol = await createChapter({ name: 'Bristol', kind: 'local', parentId: uk.id, latitude: 51.4545, longitude: -2.5879 }, db())
		await createChapter({ name: 'Edinburgh', kind: 'local', parentId: uk.id, latitude: 55.9533, longitude: -3.1883 }, db())
		expect((await routeToChapter({ country: 'Nowhere' }, {}, db())).id).toBe(global.id)
		expect((await routeToChapter({ country: 'united kingdom' }, {}, db())).id).toBe(uk.id)
		// Bath is ~18 km from Bristol.
		expect((await routeToChapter({ country: 'United Kingdom', latitude: 51.3811, longitude: -2.359 }, {}, db())).id).toBe(bristol.id)
		// Inverness is far from both local groups: stays national.
		expect((await routeToChapter({ country: 'United Kingdom', latitude: 57.4778, longitude: -4.2247 }, {}, db())).id).toBe(uk.id)
	})

	it('helpers', () => {
		expect(slugify('Pause IA — Île-de-France!')).toBe('pause-ia-ile-de-france')
		expect(Math.round(haversineKm(51.5074, -0.1278, 48.8566, 2.3522))).toBe(344)
	})
})
