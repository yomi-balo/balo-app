-- BAL-548 / ADR-1055 — THE PENDING-ACTIONS QUEUE. Two tables and five supporting indexes, in one
-- migration because the indexes are what make the queue's finder reads affordable: five NEW
-- platform-wide reads on a per-minute / per-five-minute cron, each of which would otherwise be a
-- sequential scan from the day the sweep is registered.
--
--   · `admin_alerts`      — one OPEN row per (kind, entity) that needs a person, plus the evidence
--                           snapshot (`detail`) as it was when the problem was found.
--   · `admin_sweep_ticks` — one row per sweep cadence, so the Home page can say "swept 40s ago"
--                           on an EMPTY queue. Three deliberate deviations from the house table
--                           rules (text PK, no `id`, no `deleted_at`) — see the schema docblock.
--
-- ⚠⚠ `admin_alerts_open_uidx` IS AN `ON CONFLICT` ARBITER, AND ITS PREDICATE NAMES TIMESTAMP
-- COLUMNS ONLY. "Open" is `resolved_at IS NULL`, not a `status` label — there is no status column
-- here at all. Any statement that names this index MUST RESTATE the predicate, spelled out as raw
-- literals; a parameterised restatement is rejected with 42P10 at RUNTIME. See
-- `adminAlertsRepository.raise`.
--
-- ⚠ PURELY ADDITIVE. Two new tables and five new indexes; no column is dropped, renamed or
-- retyped, no existing row is touched, and no existing constraint or index changes. Every
-- `CREATE INDEX` here is on a table that already exists, so all five take a brief ACCESS SHARE-
-- blocking lock on write traffic to that table — acceptable at current volumes; a future
-- production-scale re-run would want CONCURRENTLY (which drizzle-kit cannot emit, and which cannot
-- run inside this migration's transaction).
--
-- ⚠ TWO OF THE FIVE PREDICATES NAME ENUM LITERALS, AND BOTH ARE SAFE. The house rule ("index
-- predicates reference columns only") exists because `ALTER TYPE … ADD VALUE` cannot be used in the
-- same transaction that adds the label. `'submitted'`/`'under_review'` shipped in the ORIGINAL
-- `CREATE TYPE application_status` (migration 0000) and `'open'` in the original
-- `CREATE TYPE credit_receivable_status` (migration 0048), so neither is a just-added label.
-- Precedent: `credit_receivables_company_open_idx`. The other three predicates are columns-only,
-- honouring the emphatic in-file rule on `meeting_recordings` and `transcripts`.
--
-- ⚠ `transcript_failed_idx` IS A DELIBERATE SUPERSET. `transcriptsRepository.recordStageSkip` also
-- stamps `failed_stage` on a degraded-but-COMPLETED row, so the READ additionally filters
-- `status = 'failed'`. Do not "simplify" the read onto this predicate alone.
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "admin_alerts_manual_close_carries_a_note" CHECK (("admin_alerts"."resolved_by_user_id" IS NULL) = ("admin_alerts"."resolution_note" IS NULL)),
	CONSTRAINT "admin_alerts_resolution_attribution" CHECK ("admin_alerts"."resolved_by_user_id" IS NULL OR "admin_alerts"."resolved_at" IS NOT NULL),
	CONSTRAINT "admin_alerts_occurrences_positive" CHECK ("admin_alerts"."occurrences" >= 1)
);
--> statement-breakpoint
CREATE TABLE "admin_sweep_ticks" (
	"cadence" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_alerts_open_uidx" ON "admin_alerts" USING btree ("kind","entity_id") WHERE "admin_alerts"."resolved_at" IS NULL AND "admin_alerts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "admin_alerts_open_keyset_idx" ON "admin_alerts" USING btree ("first_seen_at","id") WHERE "admin_alerts"."resolved_at" IS NULL AND "admin_alerts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "admin_alerts_resolved_by_idx" ON "admin_alerts" USING btree ("resolved_by_user_id");--> statement-breakpoint
CREATE INDEX "expert_profiles_pending_application_idx" ON "expert_profiles" USING btree ("submitted_at") WHERE "expert_profiles"."application_status" IN ('submitted', 'under_review');--> statement-breakpoint
CREATE INDEX "transcript_failed_idx" ON "transcripts" USING btree ("created_at") WHERE "transcripts"."failed_stage" IS NOT NULL AND "transcripts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_recording_failed_idx" ON "meeting_recordings" USING btree ("created_at") WHERE "meeting_recordings"."failed_stage" IS NOT NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_recording_withheld_source_idx" ON "meeting_recordings" USING btree ("transcript_job_submitted_at") WHERE "meeting_recordings"."transcript_job_submitted_at" IS NOT NULL AND "meeting_recordings"."transcript_job_finished_at" IS NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credit_receivables_open_queue_idx" ON "credit_receivables" USING btree ("opened_at") WHERE "credit_receivables"."status" = 'open' AND "credit_receivables"."deleted_at" IS NULL;