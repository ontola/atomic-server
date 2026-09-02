// Mapping of the Airtable "National groups" table (the one the website's
// /api/national-groups reads) onto CRM chapters.
import type { AirtableRecord } from './client'

export type NationalGroupFields = {
	country?: string
	leaders_name?: string[]
	website_email?: string
	discord?: string
	whatsapp?: string
	website?: string
	inactive?: boolean
}

export const CHAPTER_FIELDS: (keyof NationalGroupFields)[] = ['country', 'website_email', 'whatsapp', 'website', 'inactive']

export type MappedChapter = {
	airtableRecordId: string
	name: string
	country: string
	email: string | null
	whatsappUrl: string | null
	websiteUrl: string | null
	active: boolean
}

export function mapChapter(record: AirtableRecord<NationalGroupFields>): MappedChapter | null {
	const country = record.fields.country?.trim()
	if (!country) return null
	return {
		airtableRecordId: record.id,
		name: `PauseAI ${country}`,
		country,
		email: record.fields.website_email?.trim() || null,
		whatsappUrl: record.fields.whatsapp?.trim() || null,
		websiteUrl: record.fields.website?.trim() || null,
		active: !record.fields.inactive
	}
}
