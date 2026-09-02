// Controlled vocabularies of the Airtable Members table, mirrored from the
// website's onboarding form (pauseai-website: src/lib/components/onboarding/options.ts).
// Keep the two in sync; the sync's drift canary reports values it does not know.

export const INTENTS = ['None', 'Keep informed', 'Act now', 'Volunteer', 'Lead'] as const

export const WEEKLY_HOURS = [
	'Less than 3 hours',
	'3-6 hours',
	'6-10 hours',
	'10-20 hours',
	'20+ hours',
	"None — I'd rather support in other ways"
] as const

export const DISCOVERY_OPTIONS = [
	'PauseAI affiliated social media',
	'Non-PauseAI affiliated social media',
	'Friend/Family referral',
	'News article',
	'Event/Presentation',
	'Internet search',
	'Other'
] as const

export const MOTIVATIONS = [
	'AI Safety',
	'Need for democratic oversight',
	'Ethical technology',
	'AI Governance',
	'Job Displacement',
	'Misinformation',
	'Deepfake scams and harassment',
	'Concentration of power',
	'Privacy loss',
	'Environmental damage',
	'Technology addiction',
	'Autonomous weapons',
	'Cyberattacks',
	'Bioweapons',
	'Other'
] as const

export const SKILLS = [
	'Software Development',
	'Video Creation',
	'Social Media Management',
	'Event Organization',
	'Public Speaking/ Presentation',
	'Writing',
	'Graphic Design/ Visual Arts',
	'Research',
	'Communications/ PR',
	'Fundraising',
	'Community Organizing',
	'Political Advocacy/ Lobbying',
	'Education/ Teaching',
	'Administrative Support',
	'Legal Knowledge',
	'Other'
] as const

/** Signup sources written by the website; anything else is legacy Tally or manual entry. */
export const KNOWN_SIGNUP_SOURCES = ['June 2026 onboarding flow', 'June 2026 subscribe form'] as const
