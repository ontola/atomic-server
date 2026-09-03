// PauseAI CRM database schema (PostgreSQL, Drizzle ORM).
//
// Design notes, in short (see docs/data-model.md for the long version):
//  - `people` is the single table for every human the movement deals with:
//    volunteers, politicians, journalists, donors and partners. Role-specific
//    data lives in the *_profiles tables so the core stays small and stable.
//  - `chapters` is a tree (Global > national > local group) with a materialized
//    `path`, so "everything under PauseAI UK" is one prefix comparison.
//  - Access to data is granted through `access_grants`, scoped to a chapter
//    subtree or a team. Nothing is derived from Discord roles directly; Discord
//    is an *identity* and a *channel*, not the authorization source.
//  - External systems (Airtable, Discord, Luma, Stripe, Substack) are linked
//    through `identities`, which keeps the sync code idempotent.
//  - Every touchpoint with a person is an `interaction`, whether we sent it or
//    they did, so a person's page shows one timeline.
import { relations, sql } from 'drizzle-orm'
import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const chapterKind = pgEnum('chapter_kind', ['global', 'national', 'local'])

export const membershipRole = pgEnum('membership_role', [
	'member',
	'volunteer',
	'team_lead',
	'chapter_lead'
])

export const membershipStatus = pgEnum('membership_status', [
	'prospect',
	'onboarding',
	'active',
	'dormant',
	'left'
])

/** System access roles. These decide what a signed-in person may see and do. */
export const accessRole = pgEnum('access_role', [
	'global_admin',
	'chapter_admin',
	'team_lead',
	'volunteer'
])

export const identityProvider = pgEnum('identity_provider', [
	'email',
	'discord',
	'whatsapp',
	'phone',
	'airtable',
	'luma',
	'stripe',
	'substack'
])

export const consentPurpose = pgEnum('consent_purpose', [
	'privacy_policy',
	'newsletter',
	'chapter_share',
	'volunteer_agreement',
	'code_of_conduct',
	'sms',
	'whatsapp'
])

export const interactionKind = pgEnum('interaction_kind', [
	'email_sent',
	'email_received',
	'message_sent',
	'message_received',
	'call',
	'meeting',
	'note',
	'event_registered',
	'event_attended',
	'action_completed',
	'task_completed',
	'statement',
	'press_mention',
	'donation'
])

export const interactionVisibility = pgEnum('interaction_visibility', ['team', 'leads', 'admins'])

export const volunteerStage = pgEnum('volunteer_stage', [
	'joined',
	'onboarding',
	'active',
	'highly_active',
	'dormant',
	'churned'
])

export const taskStatus = pgEnum('task_status', [
	'open',
	'in_progress',
	'done',
	'cancelled',
	'escalated'
])

export const attendanceStatus = pgEnum('attendance_status', ['registered', 'attended', 'no_show'])

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'failed', 'dead'])

// ---------------------------------------------------------------------------
// Organisation: chapters and teams
// ---------------------------------------------------------------------------

export const chapters = pgTable(
	'chapters',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		kind: chapterKind('kind').notNull(),
		parentId: uuid('parent_id'),
		/** Materialized path of slugs, e.g. `/global/uk/bristol`. Maintained by `chapters.ts`. */
		path: text('path').notNull(),
		/** Country name as used in the Airtable `Country` field, for routing signups. */
		country: text('country'),
		region: text('region'),
		/** Centre of the group, for distance-based routing and mailings. */
		latitude: doublePrecision('latitude'),
		longitude: doublePrecision('longitude'),
		email: text('email'),
		discordRoleId: text('discord_role_id'),
		discordChannelId: text('discord_channel_id'),
		whatsappUrl: text('whatsapp_url'),
		websiteUrl: text('website_url'),
		airtableRecordId: text('airtable_record_id'),
		active: boolean('active').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('chapters_slug_idx').on(t.slug),
		uniqueIndex('chapters_path_idx').on(t.path),
		uniqueIndex('chapters_airtable_idx').on(t.airtableRecordId),
		index('chapters_parent_idx').on(t.parentId),
		index('chapters_country_idx').on(t.country)
	]
)

export const teams = pgTable(
	'teams',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		chapterId: uuid('chapter_id')
			.notNull()
			.references(() => chapters.id, { onDelete: 'cascade' }),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		discordChannelId: text('discord_channel_id'),
		active: boolean('active').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('teams_chapter_slug_idx').on(t.chapterId, t.slug)]
)

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const people = pgTable(
	'people',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		/** Lower-cased. Nullable: politicians and journalists may be added before we have one. */
		email: text('email'),
		fullName: text('full_name').notNull().default(''),
		phone: text('phone'),
		country: text('country'),
		city: text('city'),
		postcode: text('postcode'),
		latitude: doublePrecision('latitude'),
		longitude: doublePrecision('longitude'),
		languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
		preferredLanguage: text('preferred_language'),
		/** Which hats this person wears: volunteer, politician, journalist, donor, partner. */
		kinds: text('kinds').array().notNull().default(sql`'{}'::text[]`),
		/** Airtable Members row, when this person came from or is mirrored to Airtable. */
		airtableRecordId: text('airtable_record_id'),
		source: text('source'),
		sourcePage: text('source_page'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		/** Soft delete for GDPR erasure requests; the row is scrubbed by a job afterwards. */
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('people_email_idx').on(t.email).where(sql`${t.email} is not null`),
		uniqueIndex('people_airtable_idx').on(t.airtableRecordId),
		index('people_country_idx').on(t.country),
		index('people_kinds_idx').using('gin', t.kinds)
	]
)

export const identities = pgTable(
	'identities',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		provider: identityProvider('provider').notNull(),
		/** Stable id in the provider: Discord snowflake, Airtable record id, Stripe customer id, E.164 phone. */
		externalId: text('external_id').notNull(),
		/** Human-readable handle when there is one, e.g. the Discord username. */
		handle: text('handle'),
		verifiedAt: timestamp('verified_at', { withTimezone: true }),
		meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('identities_provider_external_idx').on(t.provider, t.externalId),
		index('identities_person_idx').on(t.personId)
	]
)

export const volunteerProfiles = pgTable('volunteer_profiles', {
	personId: uuid('person_id')
		.primaryKey()
		.references(() => people.id, { onDelete: 'cascade' }),
	/** From the join form: None, Keep informed, Act now, Volunteer, Lead. */
	intent: text('intent'),
	weeklyHours: text('weekly_hours'),
	skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
	skillsOther: text('skills_other'),
	motivations: text('motivations').array().notNull().default(sql`'{}'::text[]`),
	motivationsOther: text('motivations_other'),
	discovery: text('discovery'),
	discoveryOther: text('discovery_other'),
	payingInterest: boolean('paying_interest').notNull().default(false),
	payingMember: boolean('paying_member').notNull().default(false),
	stage: volunteerStage('stage').notNull().default('joined'),
	onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
	lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const politicianProfiles = pgTable('politician_profiles', {
	personId: uuid('person_id')
		.primaryKey()
		.references(() => people.id, { onDelete: 'cascade' }),
	/** national, regional, local, eu */
	level: text('level'),
	/** e.g. "House of Commons", "Bundestag", "Gemeenteraad Utrecht" */
	body: text('body'),
	party: text('party'),
	constituency: text('constituency'),
	position: text('position'),
	/** cold, contacted, met, supportive, endorsed, opposed */
	stance: text('stance'),
	officeEmail: text('office_email'),
	surgeryInfo: text('surgery_info'),
	/** Identifier in the parliamentary record, e.g. the UK Parliament member id for Hansard lookups. */
	parliamentId: text('parliament_id'),
	meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const journalistProfiles = pgTable('journalist_profiles', {
	personId: uuid('person_id')
		.primaryKey()
		.references(() => people.id, { onDelete: 'cascade' }),
	outlet: text('outlet'),
	beat: text('beat'),
	region: text('region'),
	/** cold, pitched, replied, covered, friendly, hostile */
	stance: text('stance'),
	meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

// ---------------------------------------------------------------------------
// Belonging and access
// ---------------------------------------------------------------------------

export const memberships = pgTable(
	'memberships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		chapterId: uuid('chapter_id')
			.notNull()
			.references(() => chapters.id, { onDelete: 'cascade' }),
		role: membershipRole('role').notNull().default('member'),
		status: membershipStatus('status').notNull().default('prospect'),
		joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
		leftAt: timestamp('left_at', { withTimezone: true }),
		source: text('source')
	},
	(t) => [
		uniqueIndex('memberships_person_chapter_idx').on(t.personId, t.chapterId),
		index('memberships_chapter_idx').on(t.chapterId)
	]
)

export const teamMembers = pgTable(
	'team_members',
	{
		teamId: uuid('team_id')
			.notNull()
			.references(() => teams.id, { onDelete: 'cascade' }),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		/** member or lead */
		role: text('role').notNull().default('member'),
		joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.teamId, t.personId] })]
)

export const accessGrants = pgTable(
	'access_grants',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		role: accessRole('role').notNull(),
		/** Scope. Null chapter + null team means the whole movement (global_admin only). */
		chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
		teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
		grantedBy: uuid('granted_by').references(() => people.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true })
	},
	(t) => [index('access_grants_person_idx').on(t.personId)]
)

export const consents = pgTable(
	'consents',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		purpose: consentPurpose('purpose').notNull(),
		granted: boolean('granted').notNull(),
		/** Where the consent was captured: join form, Airtable import, preference page... */
		source: text('source').notNull(),
		recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
		evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({})
	},
	(t) => [index('consents_person_purpose_idx').on(t.personId, t.purpose, t.recordedAt)]
)

// ---------------------------------------------------------------------------
// Activity: interactions, events, attendance
// ---------------------------------------------------------------------------

export const events = pgTable(
	'events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
		title: text('title').notNull(),
		description: text('description'),
		kind: text('kind'),
		startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
		endsAt: timestamp('ends_at', { withTimezone: true }),
		location: text('location'),
		url: text('url'),
		lumaEventId: text('luma_event_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('events_luma_idx').on(t.lumaEventId), index('events_starts_idx').on(t.startsAt)]
)

export const eventAttendance = pgTable(
	'event_attendance',
	{
		eventId: uuid('event_id')
			.notNull()
			.references(() => events.id, { onDelete: 'cascade' }),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		status: attendanceStatus('status').notNull().default('registered'),
		registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
		checkedInAt: timestamp('checked_in_at', { withTimezone: true })
	},
	(t) => [primaryKey({ columns: [t.eventId, t.personId] })]
)

export const interactions = pgTable(
	'interactions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		kind: interactionKind('kind').notNull(),
		/** email, discord, whatsapp, sms, phone, in_person, web, parliament, press */
		channel: text('channel'),
		subject: text('subject'),
		body: text('body'),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		/** Who on our side did it, when a person did. Null for automated sends and imports. */
		actorPersonId: uuid('actor_person_id').references(() => people.id, { onDelete: 'set null' }),
		chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
		eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
		taskId: uuid('task_id'),
		/** Idempotency key for imports: `mailersend:<message id>`, `discord:<message id>`... */
		externalRef: text('external_ref'),
		visibility: interactionVisibility('visibility').notNull().default('leads'),
		meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('interactions_person_time_idx').on(t.personId, t.occurredAt),
		uniqueIndex('interactions_external_ref_idx')
			.on(t.externalRef)
			.where(sql`${t.externalRef} is not null`)
	]
)

// ---------------------------------------------------------------------------
// Work: project templates, projects, tasks
// ---------------------------------------------------------------------------

/** One step of a project template. Stored as JSON so templates are easy to author and version. */
export type TaskTemplateStep = {
	key: string
	title: string
	description?: string
	/** Days relative to the project's due date (negative = before) or start date. */
	dueOffsetDays: number
	dueRelativeTo?: 'start' | 'due'
	/** Who should own it by default: the project owner, a team, or anyone with a membership role. */
	defaultOwner?: 'project_owner' | 'team' | 'chapter_lead'
	/** Optional catalogue action this step corresponds to, e.g. `email_mp`. */
	actionKind?: string
	dependsOn?: string[]
}

export const projectTemplates = pgTable(
	'project_templates',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		/** event, campaign, onboarding, lobbying... */
		kind: text('kind').notNull().default('event'),
		/** Default length of the project in days, used to suggest a due date. */
		defaultDurationDays: integer('default_duration_days').notNull().default(28),
		steps: jsonb('steps').$type<TaskTemplateStep[]>().notNull().default([]),
		active: boolean('active').notNull().default(true),
		createdBy: uuid('created_by').references(() => people.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('project_templates_slug_idx').on(t.slug)]
)

export const projects = pgTable(
	'projects',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		templateId: uuid('template_id').references(() => projectTemplates.id, { onDelete: 'set null' }),
		chapterId: uuid('chapter_id')
			.notNull()
			.references(() => chapters.id, { onDelete: 'cascade' }),
		teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
		name: text('name').notNull(),
		ownerPersonId: uuid('owner_person_id').references(() => people.id, { onDelete: 'set null' }),
		startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
		dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
		/** planned, active, done, cancelled */
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('projects_chapter_idx').on(t.chapterId)]
)

export const tasks = pgTable(
	'tasks',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		templateStepKey: text('template_step_key'),
		title: text('title').notNull(),
		description: text('description'),
		ownerPersonId: uuid('owner_person_id').references(() => people.id, { onDelete: 'set null' }),
		teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
		chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
		assignedBy: uuid('assigned_by').references(() => people.id, { onDelete: 'set null' }),
		dueAt: timestamp('due_at', { withTimezone: true }),
		status: taskStatus('status').notNull().default('open'),
		priority: integer('priority').notNull().default(0),
		/** Times this task has been escalated up the ownership chain after a missed deadline. */
		escalationLevel: integer('escalation_level').notNull().default(0),
		escalatedAt: timestamp('escalated_at', { withTimezone: true }),
		/** Set when a reminder was sent so the escalation job can wait for a response first. */
		remindedAt: timestamp('reminded_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		parentTaskId: uuid('parent_task_id'),
		actionKind: text('action_kind'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('tasks_owner_status_idx').on(t.ownerPersonId, t.status),
		index('tasks_due_idx').on(t.dueAt).where(sql`${t.status} in ('open', 'in_progress')`),
		index('tasks_project_idx').on(t.projectId)
	]
)

// ---------------------------------------------------------------------------
// Plumbing: auth, jobs, sync bookkeeping, audit
// ---------------------------------------------------------------------------

export const sessions = pgTable(
	'sessions',
	{
		/** SHA-256 of the cookie value; the raw token never touches the database. */
		id: text('id').primaryKey(),
		personId: uuid('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
		userAgent: text('user_agent')
	},
	(t) => [index('sessions_person_idx').on(t.personId)]
)

export const loginTokens = pgTable('login_tokens', {
	/** SHA-256 of the token in the magic link. */
	tokenHash: text('token_hash').primaryKey(),
	email: text('email').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true })
})

export const jobs = pgTable(
	'jobs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		kind: text('kind').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		/** Optional idempotency key: a second enqueue with the same key is ignored while the first is queued. */
		dedupeKey: text('dedupe_key'),
		runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		status: jobStatus('status').notNull().default('queued'),
		lockedAt: timestamp('locked_at', { withTimezone: true }),
		lockedBy: text('locked_by'),
		lastError: text('last_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true })
	},
	(t) => [
		index('jobs_ready_idx').on(t.status, t.runAt),
		uniqueIndex('jobs_dedupe_idx')
			.on(t.dedupeKey)
			.where(sql`${t.status} in ('queued', 'running')`)
	]
)

export const syncSources = pgTable('sync_sources', {
	/** e.g. `airtable:members`, `airtable:chapters`, `luma:events` */
	source: text('source').primaryKey(),
	cursor: text('cursor'),
	lastRunAt: timestamp('last_run_at', { withTimezone: true }),
	lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
	lastError: text('last_error'),
	stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({})
})

export const webhookEvents = pgTable(
	'webhook_events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		source: text('source').notNull(),
		/** Provider-side event id, for exactly-once processing. */
		externalId: text('external_id').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
		processedAt: timestamp('processed_at', { withTimezone: true }),
		error: text('error')
	},
	(t) => [uniqueIndex('webhook_events_source_external_idx').on(t.source, t.externalId)]
)

export const auditLog = pgTable(
	'audit_log',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		actorPersonId: uuid('actor_person_id').references(() => people.id, { onDelete: 'set null' }),
		action: text('action').notNull(),
		targetTable: text('target_table').notNull(),
		targetId: text('target_id'),
		diff: jsonb('diff').$type<Record<string, unknown>>().notNull().default({}),
		at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
		ip: text('ip')
	},
	(t) => [index('audit_log_target_idx').on(t.targetTable, t.targetId)]
)

// ---------------------------------------------------------------------------
// Relations (for db.query.* convenience)
// ---------------------------------------------------------------------------

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
	parent: one(chapters, { fields: [chapters.parentId], references: [chapters.id] }),
	memberships: many(memberships),
	teams: many(teams)
}))

export const peopleRelations = relations(people, ({ one, many }) => ({
	identities: many(identities),
	memberships: many(memberships),
	consents: many(consents),
	interactions: many(interactions, { relationName: 'subject' }),
	grants: many(accessGrants),
	volunteer: one(volunteerProfiles, {
		fields: [people.id],
		references: [volunteerProfiles.personId]
	}),
	politician: one(politicianProfiles, {
		fields: [people.id],
		references: [politicianProfiles.personId]
	}),
	journalist: one(journalistProfiles, {
		fields: [people.id],
		references: [journalistProfiles.personId]
	})
}))

export const identitiesRelations = relations(identities, ({ one }) => ({
	person: one(people, { fields: [identities.personId], references: [people.id] })
}))

export const membershipsRelations = relations(memberships, ({ one }) => ({
	person: one(people, { fields: [memberships.personId], references: [people.id] }),
	chapter: one(chapters, { fields: [memberships.chapterId], references: [chapters.id] })
}))

export const consentsRelations = relations(consents, ({ one }) => ({
	person: one(people, { fields: [consents.personId], references: [people.id] })
}))

export const interactionsRelations = relations(interactions, ({ one }) => ({
	person: one(people, {
		fields: [interactions.personId],
		references: [people.id],
		relationName: 'subject'
	}),
	actor: one(people, { fields: [interactions.actorPersonId], references: [people.id] })
}))

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
	person: one(people, { fields: [accessGrants.personId], references: [people.id] }),
	chapter: one(chapters, { fields: [accessGrants.chapterId], references: [chapters.id] }),
	team: one(teams, { fields: [accessGrants.teamId], references: [teams.id] })
}))

export const tasksRelations = relations(tasks, ({ one }) => ({
	project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
	owner: one(people, { fields: [tasks.ownerPersonId], references: [people.id] })
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
	template: one(projectTemplates, { fields: [projects.templateId], references: [projectTemplates.id] }),
	chapter: one(chapters, { fields: [projects.chapterId], references: [chapters.id] }),
	tasks: many(tasks)
}))

export type Chapter = typeof chapters.$inferSelect
export type Person = typeof people.$inferSelect
export type NewPerson = typeof people.$inferInsert
export type Identity = typeof identities.$inferSelect
export type Membership = typeof memberships.$inferSelect
export type AccessGrant = typeof accessGrants.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Job = typeof jobs.$inferSelect
export type ProjectTemplate = typeof projectTemplates.$inferSelect
