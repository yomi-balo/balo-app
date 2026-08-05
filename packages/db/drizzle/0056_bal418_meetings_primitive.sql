-- BAL-418 / ADR-1045 §2/§3/§6 + ADR-1043 §1/§2 — the MEETINGS PRIMITIVE.
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate` (precedent for hand-edited
-- generated SQL with an explanatory header: 0022_even_ozymandias.sql, 0030_heavy_kang.sql,
-- 0055_bal417_engagement_supertype.sql). Two classes of deviation:
--
--   A. STATEMENT ORDER was regrouped so each table's DDL, its FKs and its indexes are
--      contiguous, and so every data-correction step sits IMMEDIATELY before the
--      constraint it unblocks. No statement was added or removed by this regrouping.
--
--   B. THREE DATA-CORRECTION STEPS were ADDED (drizzle never emits these). Each one
--      unblocks a constraint that would otherwise fail on a NON-EMPTY database:
--
--      ┌─ meeting_guests ────────────────────────────────────────────────────────────
--      │ `meeting_id` is NOT NULL with NO FK, and EVERY existing value is garbage — the
--      │ target table never existed — so `ADD CONSTRAINT` fails 23503 on any row.
--      │ HANDLING: `DELETE FROM "meeting_guests"`.
--      │ SAFE BECAUSE: a repo-wide grep finds NO writer (only admin-dev/_actions/
--      │ delete-user.ts, which never inserts and never reads `meeting_id`); `seed.ts`
--      │ does not touch the table. Any surviving row is a hand-seeded dev fixture with a
--      │ uuid that resolves to nothing. Pre-launch, no live data (the 0055 ruling).
--      │ REJECTED: `NOT VALID` — it leaves a permanently unvalidated constraint and a
--      │ silently-wrong table, which is worse than the stub it replaces.
--      ├─ transcripts (+ transcript_artifacts) ──────────────────────────────────────
--      │ `SET NOT NULL` fails 23502 on any row, and every live row has
--      │ `meeting_id = NULL` (there is no producer).
--      │ HANDLING: `DELETE` the artifacts, THEN the transcripts (child first — do not
--      │ rely on the cascade).
--      │ SAFE BECAUSE: BAL-387 shipped INERT — no live capture producer exists
--      │ (BAL-126/140 unbuilt).
--      ├─ action_items ─────────────────────────────────────────────────────────────
--      │ The column is NULLABLE, so only rows carrying a non-NULL garbage uuid break the
--      │ FK add.
--      │ HANDLING: `UPDATE … SET meeting_id = NULL WHERE meeting_id IS NOT NULL` — an
--      │ UPDATE, NEVER a DELETE, and PREDICATED so it touches only the offending rows.
--      │ Without the WHERE, Postgres MVCC-rewrites EVERY row of a live table (new tuple
--      │ per row + index maintenance + bloat) to write a value that is already there.
--      │ SAFE BECAUSE: this table has a LIVE surface with real rows (the engagement
--      │ action-item panel). Deleting them would destroy user data. Nulling a column
--      │ that could never have pointed at anything real loses nothing.
--      └─ credit_sessions ──────────────────────────────────────────────────────────
--        New NULLABLE columns only — `ADD COLUMN` nullable is always safe, no handling.
--
-- ⚠ NONE OF SECTION B IS EXERCISED BY CI (memory
-- `reference_db_migrations_tested_against_empty_db`): the integration harness migrates an
-- EMPTY testcontainer and the E2E job migrates a fresh service container, so every
-- DELETE / UPDATE / SET NOT NULL below is a no-op in both.
--
-- AN EARLIER DRAFT OF THIS HEADER ASKED THE READER TO VERIFY THE COUNTS AGAINST THE SEEDED
-- DEV DB. THAT WAS WRONG AND IS REMOVED — two of the three tables DO NOT EXIST on balo-dev
-- (it sits at 43 applied migrations; `transcripts` arrives in 0051 and `action_items` in
-- 0049, both still pending), so the commands could not run. There is also no other
-- database: Supabase lists exactly one project org-wide, no staging, no production.
--
-- The correct justification is STATIC, and it is stronger than a count would have been —
-- section B cannot fire on any environment reachable from this repo:
--   (1) 0055 (already on main) does `ALTER TABLE engagements ADD COLUMN engagement_type
--       NOT NULL` with NO DEFAULT — 23502 on a non-empty `engagements`, deliberately (see
--       its own header: "the fix is to reset that database"). `action_items.engagement_id`
--       and `transcripts.engagement_id` are both NOT NULL FKs ON DELETE cascade ->
--       engagements, and `transcript_artifacts` cascades off `transcripts`. So ANY database
--       that successfully applied 0055 had all three cascade-emptied on the way through.
--       `meeting_guests` has NO INSERT anywhere in the repo (only admin-dev's delete-user
--       action, which deletes/updates) and `seed.ts` never touches it.
--   (2) Nothing can dirty them in the 0055 -> 0056 window either: `action_items.meeting_id`
--       is written only by action-items.ts create/createFromExtraction — the web action is
--       `.strict()` and REJECTS a client-supplied meetingId, and createFromExtraction is fed
--       only by the BAL-387 pipeline, which shipped INERT (no capture producer; BAL-126/140
--       unbuilt). Same inertness leaves `transcripts` with no producer at all.
--   (3) The DDL itself IS covered: both CI paths migrate 0000 -> 0056 from scratch,
--       exercising every table, FK, CHECK, partial index and the enum-default safety.
--
-- The ONLY way to reach a non-zero count is a hand-INSERTed fixture placed with a SQL
-- client. If your local DB has one, these three steps are exactly what will clean it up.
--
-- The genuinely uncovered risk is NOT section B — it is the 14-migration catch-up
-- 0043 -> 0056 against balo-dev in its real state (43 applied, 66 users). That belongs to
-- 0043-0055 (most sharply 0055's engagements add), is a DEPLOY-time concern for whoever
-- migrates balo-dev, and is not this migration's to own.
--
-- ENUM-DEFAULT / ENUM-LITERAL SAFETY: all four types below are STANDALONE `CREATE TYPE`s,
-- so `meetings.status DEFAULT 'scheduled'` and the `'ended'` / `'admin'` literals inside
-- the two CHECKs are safe in this same migration. Memory
-- `reference_enum_default_same_tx_migration_hazard` applies ONLY to
-- `ALTER TYPE … ADD VALUE`, which none of these are. A FUTURE migration that ADD-VALUEs a
-- `meeting_status` / `meeting_context_type` label MUST NOT rewrite those CHECKs in that
-- same migration.

-- ── 1. Enums (standalone CREATE TYPE — every label commits atomically with the type) ──
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'waiting_for_participants', 'in_progress', 'ended');--> statement-breakpoint
CREATE TYPE "public"."meeting_outcome" AS ENUM('completed', 'no_show_client', 'missed_call');--> statement-breakpoint
CREATE TYPE "public"."meeting_context_type" AS ENUM('case', 'project_discovery', 'project_kickoff', 'package_session', 'retainer_checkin', 'admin');--> statement-breakpoint
CREATE TYPE "public"."meeting_participant_party" AS ENUM('expert', 'client', 'observer');--> statement-breakpoint

-- ── 2. meetings — NO CONTEXT COLUMN (the load-bearing constraint; see schema/meetings.ts) ──
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"outcome" "meeting_outcome",
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"daily_room_name" text,
	"join_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_scheduled_start_before_end" CHECK ("meetings"."scheduled_start" < "meetings"."scheduled_end"),
	CONSTRAINT "meeting_outcome_requires_ended" CHECK ("meetings"."outcome" IS NULL OR "meetings"."status" = 'ended')
);
--> statement-breakpoint
CREATE INDEX "meeting_status_scheduled_start_idx" ON "meetings" USING btree ("status","scheduled_start") WHERE "meetings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_daily_room_name_idx" ON "meetings" USING btree ("daily_room_name") WHERE "meetings"."daily_room_name" IS NOT NULL AND "meetings"."deleted_at" IS NULL;--> statement-breakpoint

-- ── 3. meeting_contexts — the polymorphic seam (context_id has NO FK by design) ──
CREATE TABLE "meeting_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"context_type" "meeting_context_type" NOT NULL,
	"context_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_context_admin_no_id" CHECK (("meeting_contexts"."context_id" IS NULL) = ("meeting_contexts"."context_type" = 'admin'))
);
--> statement-breakpoint
ALTER TABLE "meeting_contexts" ADD CONSTRAINT "meeting_contexts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_context_unique_idx" ON "meeting_contexts" USING btree ("meeting_id","context_type","context_id") WHERE "meeting_contexts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_context_admin_uq" ON "meeting_contexts" USING btree ("meeting_id") WHERE "meeting_contexts"."context_id" IS NULL AND "meeting_contexts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_context_reverse_idx" ON "meeting_contexts" USING btree ("context_type","context_id") WHERE "meeting_contexts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_context_meeting_idx" ON "meeting_contexts" USING btree ("meeting_id");--> statement-breakpoint

-- ── 4. meeting_presence — one row per join→leave INTERVAL (BAL-134's two clocks) ──
CREATE TABLE "meeting_presence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid,
	"party" "meeting_participant_party" NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_presence_left_after_joined" CHECK ("meeting_presence"."left_at" IS NULL OR "meeting_presence"."left_at" >= "meeting_presence"."joined_at")
);
--> statement-breakpoint
ALTER TABLE "meeting_presence" ADD CONSTRAINT "meeting_presence_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_presence" ADD CONSTRAINT "meeting_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_presence_meeting_party_idx" ON "meeting_presence" USING btree ("meeting_id","party","joined_at") WHERE "meeting_presence"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_presence_open_idx" ON "meeting_presence" USING btree ("meeting_id") WHERE "meeting_presence"."left_at" IS NULL AND "meeting_presence"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_presence_one_open_per_user_idx" ON "meeting_presence" USING btree ("meeting_id","user_id") WHERE "meeting_presence"."left_at" IS NULL AND "meeting_presence"."deleted_at" IS NULL;--> statement-breakpoint

-- ── 5. ORPHAN HANDLING (meeting_guests) — see header block B. NOT emitted by drizzle. ──
DELETE FROM "meeting_guests";--> statement-breakpoint

-- ── 6. meeting_guests — the dangling no-FK stub becomes a real FK ──
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guests_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_guest_meeting_idx" ON "meeting_guests" USING btree ("meeting_id");--> statement-breakpoint

-- ── 7. ORPHAN HANDLING (transcripts) — CHILD FIRST. NOT emitted by drizzle. ──
DELETE FROM "transcript_artifacts";--> statement-breakpoint
DELETE FROM "transcripts";--> statement-breakpoint

-- ── 8. transcripts — meeting_id becomes NOT NULL + a real FK; index predicate simplified ──
ALTER TABLE "transcripts" ALTER COLUMN "meeting_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "transcript_meeting_idx";--> statement-breakpoint
CREATE INDEX "transcript_meeting_idx" ON "transcripts" USING btree ("meeting_id") WHERE "transcripts"."deleted_at" IS NULL;--> statement-breakpoint

-- ── 9. ORPHAN HANDLING (action_items) — UPDATE, NEVER DELETE. NOT emitted by drizzle. ──
UPDATE "action_items" SET "meeting_id" = NULL WHERE "meeting_id" IS NOT NULL;--> statement-breakpoint

-- ── 10. action_items — nullable no-FK stub becomes a NULLABLE FK (D1: engagement_id stays) ──
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── 11. credit_sessions — the meeting link + the denormalised engagement (both nullable) ──
ALTER TABLE "credit_sessions" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "engagement_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_sessions_meeting_idx" ON "credit_sessions" USING btree ("meeting_id","ended_at") WHERE "credit_sessions"."meeting_id" IS NOT NULL AND "credit_sessions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credit_sessions_engagement_idx" ON "credit_sessions" USING btree ("engagement_id") WHERE "credit_sessions"."engagement_id" IS NOT NULL AND "credit_sessions"."deleted_at" IS NULL;
