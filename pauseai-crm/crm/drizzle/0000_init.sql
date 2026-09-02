CREATE TYPE "public"."access_role" AS ENUM('global_admin', 'chapter_admin', 'team_lead', 'volunteer');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('registered', 'attended', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."chapter_kind" AS ENUM('global', 'national', 'local');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('privacy_policy', 'newsletter', 'chapter_share', 'volunteer_agreement', 'code_of_conduct', 'sms', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('email', 'discord', 'whatsapp', 'phone', 'airtable', 'luma', 'stripe', 'substack');--> statement-breakpoint
CREATE TYPE "public"."interaction_kind" AS ENUM('email_sent', 'email_received', 'message_sent', 'message_received', 'call', 'meeting', 'note', 'event_registered', 'event_attended', 'action_completed', 'task_completed', 'statement', 'press_mention', 'donation');--> statement-breakpoint
CREATE TYPE "public"."interaction_visibility" AS ENUM('team', 'leads', 'admins');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('member', 'volunteer', 'team_lead', 'chapter_lead');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('prospect', 'onboarding', 'active', 'dormant', 'left');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'done', 'cancelled', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."volunteer_stage" AS ENUM('joined', 'onboarding', 'active', 'highly_active', 'dormant', 'churned');--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "access_role" NOT NULL,
	"chapter_id" uuid,
	"team_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_person_id" uuid,
	"action" text NOT NULL,
	"target_table" text NOT NULL,
	"target_id" text,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "chapter_kind" NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"country" text,
	"region" text,
	"latitude" double precision,
	"longitude" double precision,
	"email" text,
	"discord_role_id" text,
	"discord_channel_id" text,
	"whatsapp_url" text,
	"website_url" text,
	"airtable_record_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendance" (
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "attendance_status" DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_at" timestamp with time zone,
	CONSTRAINT "event_attendance_event_id_person_id_pk" PRIMARY KEY("event_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"kind" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text,
	"url" text,
	"luma_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"external_id" text NOT NULL,
	"handle" text,
	"verified_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"channel" text,
	"subject" text,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_person_id" uuid,
	"chapter_id" uuid,
	"event_id" uuid,
	"task_id" uuid,
	"external_ref" text,
	"visibility" "interaction_visibility" DEFAULT 'leads' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journalist_profiles" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"outlet" text,
	"beat" text,
	"region" text,
	"stance" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"status" "membership_status" DEFAULT 'prospect' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"full_name" text DEFAULT '' NOT NULL,
	"phone" text,
	"country" text,
	"city" text,
	"postcode" text,
	"latitude" double precision,
	"longitude" double precision,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_language" text,
	"kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"airtable_record_id" text,
	"source" text,
	"source_page" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "politician_profiles" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"level" text,
	"body" text,
	"party" text,
	"constituency" text,
	"position" text,
	"stance" text,
	"office_email" text,
	"surgery_info" text,
	"parliament_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'event' NOT NULL,
	"default_duration_days" integer DEFAULT 28 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid,
	"chapter_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"owner_person_id" uuid,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "sync_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"template_step_key" text,
	"title" text NOT NULL,
	"description" text,
	"owner_person_id" uuid,
	"team_id" uuid,
	"chapter_id" uuid,
	"assigned_by" uuid,
	"due_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"parent_task_id" uuid,
	"action_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_person_id_pk" PRIMARY KEY("team_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discord_channel_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_profiles" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"intent" text,
	"weekly_hours" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills_other" text,
	"motivations" text[] DEFAULT '{}'::text[] NOT NULL,
	"motivations_other" text,
	"discovery" text,
	"discovery_other" text,
	"paying_interest" boolean DEFAULT false NOT NULL,
	"paying_member" boolean DEFAULT false NOT NULL,
	"stage" "volunteer_stage" DEFAULT 'joined' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_by_people_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journalist_profiles" ADD CONSTRAINT "journalist_profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politician_profiles" ADD CONSTRAINT "politician_profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_template_id_project_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."project_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_by_people_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_person_idx" ON "access_grants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_table","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_slug_idx" ON "chapters" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_path_idx" ON "chapters" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_airtable_idx" ON "chapters" USING btree ("airtable_record_id");--> statement-breakpoint
CREATE INDEX "chapters_parent_idx" ON "chapters" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "chapters_country_idx" ON "chapters" USING btree ("country");--> statement-breakpoint
CREATE INDEX "consents_person_purpose_idx" ON "consents" USING btree ("person_id","purpose","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_luma_idx" ON "events" USING btree ("luma_event_id");--> statement-breakpoint
CREATE INDEX "events_starts_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_provider_external_idx" ON "identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "identities_person_idx" ON "identities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "interactions_person_time_idx" ON "interactions" USING btree ("person_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_external_ref_idx" ON "interactions" USING btree ("external_ref") WHERE "interactions"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_person_chapter_idx" ON "memberships" USING btree ("person_id","chapter_id");--> statement-breakpoint
CREATE INDEX "memberships_chapter_idx" ON "memberships" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_email_idx" ON "people" USING btree ("email") WHERE "people"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "people_airtable_idx" ON "people" USING btree ("airtable_record_id");--> statement-breakpoint
CREATE INDEX "people_country_idx" ON "people" USING btree ("country");--> statement-breakpoint
CREATE INDEX "people_kinds_idx" ON "people" USING gin ("kinds");--> statement-breakpoint
CREATE UNIQUE INDEX "project_templates_slug_idx" ON "project_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_chapter_idx" ON "projects" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "sessions_person_idx" ON "sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_status_idx" ON "tasks" USING btree ("owner_person_id","status");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_at") WHERE "tasks"."status" in ('open', 'in_progress');--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_chapter_slug_idx" ON "teams" USING btree ("chapter_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_external_idx" ON "webhook_events" USING btree ("source","external_id");