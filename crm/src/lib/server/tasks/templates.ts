// Built-in project templates. Seeded into `project_templates` by `pnpm db:seed`
// and editable from there; this file is the version-controlled starting point.
// Offsets are days relative to the project due date (the event day) unless
// `dueRelativeTo: 'start'`.
import type { TaskTemplateStep } from '../db/schema'

export type BuiltInTemplate = {
	slug: string
	name: string
	kind: string
	description: string
	defaultDurationDays: number
	steps: TaskTemplateStep[]
}

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
	{
		slug: 'watch-party-and-emails',
		name: 'Simple local event: screening, emails, pub',
		kind: 'event',
		description:
			'A low-effort evening that reliably works: screen two or three short videos, get everyone to email their representative on the spot, then go to the pub. Follow every step and it will go fine.',
		defaultDurationDays: 21,
		steps: [
			{ key: 'venue', title: 'Book a venue with a screen (community hall, pub function room, university room)', dueOffsetDays: -18, description: 'Free or cheap is fine. You need a screen or projector, sound, and seats for 15 to 30.' },
			{ key: 'date', title: 'Fix the date and create the Luma event', dueOffsetDays: -16, description: 'Weekday evenings from 18:30 work best. Put the Luma link in the chapter WhatsApp and Discord channel.' },
			{ key: 'videos', title: 'Pick the two or three videos to show (use the shared playlist)', dueOffsetDays: -10 },
			{ key: 'invite', title: 'Personally invite ten people from your own circle', dueOffsetDays: -9, description: 'Message them one by one. Group posts get ignored; personal messages get replies.' },
			{ key: 'reminder-week', title: 'Post a reminder in the local group and ask members to bring a friend', dueOffsetDays: -7, defaultOwner: 'team' },
			{ key: 'email-tool', title: 'Test the email-your-representative tool on your phone', dueOffsetDays: -3, actionKind: 'email_mp' },
			{ key: 'reminder-day', title: 'Send the day-before reminder with the address and start time', dueOffsetDays: -1 },
			{ key: 'run', title: 'Run the event: welcome, videos, emails on phones, pub', dueOffsetDays: 0 },
			{ key: 'followup', title: 'Thank attendees, share photos, log attendance in the CRM', dueOffsetDays: 2 },
			{ key: 'debrief', title: 'Write three lines: what worked, what to change, next date', dueOffsetDays: 4 }
		]
	},
	{
		slug: 'mp-surgery-visit',
		name: 'Visit your MP at their surgery',
		kind: 'lobbying',
		description: 'Get three to five constituents in front of their MP at a constituency surgery, with one clear ask.',
		defaultDurationDays: 28,
		steps: [
			{ key: 'find', title: 'Find the surgery dates and booking method on the MP website', dueOffsetDays: -24 },
			{ key: 'group', title: 'Recruit three to five constituents from the local group', dueOffsetDays: -18, defaultOwner: 'team' },
			{ key: 'book', title: 'Book the slot (some MPs need each constituent to book separately)', dueOffsetDays: -14 },
			{ key: 'brief', title: 'Read the policy briefing and agree the one ask', dueOffsetDays: -7 },
			{ key: 'rehearse', title: 'Do a fifteen-minute rehearsal call', dueOffsetDays: -2 },
			{ key: 'visit', title: 'Attend the surgery', dueOffsetDays: 0 },
			{ key: 'log', title: 'Log the meeting and what the MP said in the CRM', dueOffsetDays: 1, description: 'Add it as an interaction on the MP record. Quotes verbatim where you can.' },
			{ key: 'thanks', title: 'Send the thank-you email with the briefing attached', dueOffsetDays: 2 }
		]
	},
	{
		slug: 'volunteer-onboarding',
		name: 'Onboard a new volunteer',
		kind: 'onboarding',
		description: 'What the chapter does in the first two weeks after someone says they want to volunteer.',
		defaultDurationDays: 14,
		steps: [
			{ key: 'welcome', title: 'Send a personal welcome message (not a template) within 48 hours', dueOffsetDays: 2, dueRelativeTo: 'start' },
			{ key: 'call', title: 'Invite them to the next welcome call or a fifteen-minute chat', dueOffsetDays: 5, dueRelativeTo: 'start' },
			{ key: 'first-action', title: 'Give them one concrete first action (email their representative)', dueOffsetDays: 7, dueRelativeTo: 'start', actionKind: 'email_mp' },
			{ key: 'groups', title: 'Add them to the local WhatsApp group and Discord role', dueOffsetDays: 7, dueRelativeTo: 'start' },
			{ key: 'checkin', title: 'Check in: did the first action happen? What next?', dueOffsetDays: 14, dueRelativeTo: 'start' }
		]
	}
]
