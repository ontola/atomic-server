// Mapping of the Airtable "Members" table onto CRM people. The field names are
// the canonical ones the website writes (pauseai-website
// src/routes/embed/onboarding-form/+page.server.ts); legacy Tally-era fields
// carry a "(legacy)" suffix in Airtable and are deliberately not read.
import type { AirtableRecord } from './client'
import { DISCOVERY_OPTIONS, INTENTS, KNOWN_SIGNUP_SOURCES, MOTIVATIONS, SKILLS, WEEKLY_HOURS } from './vocab'

export type MembersFields = {
	Email?: string
	'Full name'?: string
	Country?: string
	City?: string
	'Zip code'?: string
	Phone?: string
	'Discord Username'?: string
	Languages?: string[]
	'Other languages'?: string
	Intent?: string
	'Signup source'?: string
	'Source page'?: string
	'Email subscription'?: boolean
	'GDPR chapter share permission'?: boolean
	'Data privacy policy agreed'?: boolean
	'Volunteer Agreement'?: boolean
	'Code of Conduct agreed'?: boolean
	'Discovery method of PAI'?: string
	'Discovery method of PAI (Other)'?: string
	Motivation?: string[]
	'Motivation (Other)'?: string
	'Skills & Interests'?: string[]
	'Skill & Interests (Other)'?: string
	'Projected weekly hours'?: string
	'Paying Interest'?: boolean
	'Paying member'?: boolean
	duplicate?: boolean
	'Last modified'?: string
}

/** The Airtable fields the sync asks for. Keeping the list explicit keeps PII we do not need out of the process. */
export const MEMBER_FIELDS: (keyof MembersFields)[] = [
	'Email',
	'Full name',
	'Country',
	'City',
	'Zip code',
	'Phone',
	'Discord Username',
	'Languages',
	'Other languages',
	'Intent',
	'Signup source',
	'Source page',
	'Email subscription',
	'GDPR chapter share permission',
	'Data privacy policy agreed',
	'Volunteer Agreement',
	'Code of Conduct agreed',
	'Discovery method of PAI',
	'Discovery method of PAI (Other)',
	'Motivation',
	'Motivation (Other)',
	'Skills & Interests',
	'Skill & Interests (Other)',
	'Projected weekly hours',
	'Paying Interest',
	'Paying member',
	'duplicate'
]

export type MappedMember = {
	airtableRecordId: string
	person: {
		email: string | null
		fullName: string
		phone: string | null
		country: string | null
		city: string | null
		postcode: string | null
		languages: string[]
	}
	discordUsername: string | null
	profile: {
		intent: string | null
		weeklyHours: string | null
		skills: string[]
		skillsOther: string | null
		motivations: string[]
		motivationsOther: string | null
		discovery: string | null
		discoveryOther: string | null
		payingInterest: boolean
		payingMember: boolean
	}
	consents: { purpose: 'privacy_policy' | 'newsletter' | 'chapter_share' | 'volunteer_agreement' | 'code_of_conduct'; granted: boolean }[]
	source: string | null
	sourcePage: string | null
	duplicate: boolean
	/** Vocabulary values this build does not know. Reported, never rejected. */
	drift: { field: string; value: string }[]
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const bool = (v: unknown): boolean => v === true

export function mapMember(record: AirtableRecord<MembersFields>): MappedMember {
	const f = record.fields
	const drift: MappedMember['drift'] = []
	const check = (field: string, value: string | null, allowed: readonly string[]) => {
		if (value && !allowed.includes(value)) drift.push({ field, value })
		return value
	}
	const checkAll = (field: string, values: string[], allowed: readonly string[]) => {
		for (const v of values) if (!allowed.includes(v)) drift.push({ field, value: v })
		return values
	}

	const source = text(f['Signup source'])
	if (source && !(KNOWN_SIGNUP_SOURCES as readonly string[]).includes(source)) {
		drift.push({ field: 'Signup source', value: source })
	}

	const consents: MappedMember['consents'] = []
	if (f['Data privacy policy agreed'] !== undefined) consents.push({ purpose: 'privacy_policy', granted: bool(f['Data privacy policy agreed']) })
	if (f['Email subscription'] !== undefined) consents.push({ purpose: 'newsletter', granted: bool(f['Email subscription']) })
	if (f['GDPR chapter share permission'] !== undefined) consents.push({ purpose: 'chapter_share', granted: bool(f['GDPR chapter share permission']) })
	if (f['Volunteer Agreement'] !== undefined) consents.push({ purpose: 'volunteer_agreement', granted: bool(f['Volunteer Agreement']) })
	if (f['Code of Conduct agreed'] !== undefined) consents.push({ purpose: 'code_of_conduct', granted: bool(f['Code of Conduct agreed']) })

	return {
		airtableRecordId: record.id,
		person: {
			email: text(f.Email)?.toLowerCase() ?? null,
			fullName: text(f['Full name']) ?? '',
			phone: text(f.Phone),
			country: text(f.Country),
			city: text(f.City),
			postcode: text(f['Zip code']),
			languages: list(f.Languages)
		},
		discordUsername: normalizeDiscordUsername(text(f['Discord Username'])),
		profile: {
			intent: check('Intent', text(f.Intent), INTENTS),
			weeklyHours: check('Projected weekly hours', text(f['Projected weekly hours']), WEEKLY_HOURS),
			skills: checkAll('Skills & Interests', list(f['Skills & Interests']), SKILLS),
			skillsOther: text(f['Skill & Interests (Other)']),
			motivations: checkAll('Motivation', list(f.Motivation), MOTIVATIONS),
			motivationsOther: text(f['Motivation (Other)']),
			discovery: check('Discovery method of PAI', text(f['Discovery method of PAI']), DISCOVERY_OPTIONS),
			discoveryOther: text(f['Discovery method of PAI (Other)']),
			payingInterest: bool(f['Paying Interest']),
			payingMember: bool(f['Paying member'])
		},
		consents,
		source,
		sourcePage: text(f['Source page']),
		duplicate: bool(f.duplicate),
		drift
	}
}

/** People type Discord handles in every shape: `@Name`, `name#1234`, `Name `. Store the modern lower-case form. */
export function normalizeDiscordUsername(value: string | null): string | null {
	if (!value) return null
	const cleaned = value.trim().replace(/^@/, '').replace(/#\d{4}$/, '').toLowerCase()
	return cleaned || null
}

/** Volunteer or lead intent, or an agreement signed, means this row is a volunteer rather than a subscriber. */
export function isVolunteer(m: MappedMember): boolean {
	return (
		m.profile.intent === 'Volunteer' ||
		m.profile.intent === 'Lead' ||
		m.consents.some((c) => c.purpose === 'volunteer_agreement' && c.granted)
	)
}
