-- BAL-420 / ADR-1047 — SCHEDULED & DELAYED NOTIFICATION DISPATCH (Postgres as the clock),
-- plus the BAL-341 absorption into `notification_log` (ADR Decision 8).
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate` (precedent for hand-edited
-- generated SQL with an explanatory header: 0022_even_ozymandias.sql, 0030_heavy_kang.sql,
-- 0055_bal417_engagement_supertype.sql, 0056_bal418_meetings_primitive.sql). TWO edits,
-- both on line-for-line identical statements:
--
--   A. `ALTER COLUMN "correlation_id" SET DATA TYPE text` gained an explicit
--      `USING "correlation_id"::text`. drizzle-kit emitted the retype WITHOUT a USING
--      clause and, importantly, did NOT emit a DROP-and-ADD — the data-destroying form
--      ADR R11 warns about. The USING is added anyway so the cast is stated rather than
--      inferred from Postgres's I/O-conversion fallback, and so a reader can see at a
--      glance that no data is discarded.
--
--   B. This header, and section comments. No statement was added, removed or reordered.
--
-- ─────────────────────────────────────────────────────────────────────────────────────
-- NON-EMPTY-DATABASE SAFETY, REASONED COLUMN BY COLUMN
--
-- ⚠ NONE OF THE `notification_log` ALTERATIONS BELOW ARE PROVEN BY ANY TEST. The
-- integration harness migrates an EMPTY testcontainer and the E2E job a fresh service
-- container (memory `reference_db_migrations_tested_against_empty_db`), so on both the
-- retype rewrites zero rows and the CHECK validates against zero rows. What follows is a
-- static argument, and it is the only argument there is.
--
--   ┌─ ALTER COLUMN "correlation_id" SET DATA TYPE text USING …::text ────────────────
--   │ A TABLE REWRITE (ACCESS EXCLUSIVE for its duration).
--   │ CORRECTNESS IS UNCONDITIONAL: every stored value is a uuid and uuid→text is total —
--   │ no value can fail the cast, so the statement cannot abort part-way. Nothing depends
--   │ on the uuid TYPE either: the column carries a PLAIN NON-UNIQUE index (recreated
--   │ automatically by the rewrite), participates in NO join anywhere in the repo, and its
--   │ only reader `findByCorrelationId` uses `eq()` on a `string` parameter — it has ZERO
--   │ non-test callers today. Widening is strictly permissive: every value that was legal
--   │ stays legal.
--   │
--   │ ⚠ AVAILABILITY IS *NOT* UNCONDITIONAL — THE LOCK IS INVISIBLE TO READERS, NOT TO
--   │ WRITERS, AND THIS TABLE HAS WRITERS. `notification_log` has no live READER on the
--   │ request path, but `logNotification` WRITES to it from every channel worker
--   │ (`email.adapter`, `sms.adapter`, `in-app.adapter`) on every delivery. ACCESS
--   │ EXCLUSIVE does not make those inserts fail — it makes them BLOCK. `logNotification`'s
--   │ swallowing catch does not help here: a blocked insert is not an error, it is a wait.
--   │
--   │ ⚠ AND NOT FOR THE REWRITE ALONE — THE LOCK IS HELD UNTIL THE WHOLE MIGRATION RUN
--   │ COMMITS. drizzle-orm wraps EVERY PENDING MIGRATION in ONE transaction (0.38.4:
--   │ `pg-core/dialect.js` `migrate()` — a single `session.transaction()` encloses the
--   │ `for await (const migration of migrations)` loop), the same fact the ENUM HAZARDS
--   │ section below leans on. So writers stay blocked for: this rewrite (cost proportional
--   │ to the table's size) + the `notification_log_recipient_exactly_one` CHECK, whose
--   │ validation is a SECOND full scan of this same table (last statement in this file) +
--   │ every other migration still pending in the same run. Size the window off the whole
--   │ run, never off the rewrite alone.
--   │
--   │ WHY A BLOCKED AUDIT WRITE CAN COST A DUPLICATE EMAIL — and note this migration does
--   │ not CREATE that failure mode, it WIDENS a pre-existing one: the log write already
--   │ happens AFTER the side effect (`sendTransacEmail` then `logNotification` in
--   │ `email.adapter.ts`), so anything that re-runs a delivery job re-sends. While the
--   │ worker process is alive its BullMQ lock keeps being renewed on a timer
--   │ (`lockRenewTime = lockDuration / 2`), so merely waiting on Postgres does not by itself
--   │ stall a job. The exposure comes from WHEN this runs: when the migration is applied as
--   │ part of a deploy — the usual practice, though note nothing in this repo runs
--   │ migrations at deploy time TODAY: there is no Railway release command, and the only
--   │ `db:migrate` is the E2E CI job — the worker process is being replaced at that same
--   │ moment. Shutdown makes it worse rather than better: `apps/api/src/index.ts`'s SIGTERM
--   │ handler closes Fastify and `process.exit(0)`s WITHOUT draining BullMQ workers. A
--   │ worker killed while its jobs sit blocked stops renewing; the locks lapse (default
--   │ lockDuration 30s, stalledInterval 30s, maxStalledCount 1 — none overridden in
--   │ `startEmailWorker`), BullMQ re-delivers each job as stalled, and the new process runs
--   │ the processor FROM THE TOP. Because maxStalledCount is 1 the FIRST stall re-queues
--   │ rather than fails, so: at most ONE duplicate, and only for a job already PAST its send
--   │ and blocked on the audit write — a job killed BEFORE its send simply re-runs and sends
--   │ once. Confined to the deploy window. Secondary effect: with `concurrency: 5`, five
--   │ blocked jobs are the whole email queue, so deliveries queue up behind the rewrite.
--   │
--   │ ⚙ BEFORE DEPLOYING THIS MIGRATION: check the table's size —
--   │     SELECT count(*) FROM notification_log;
--   │   A small table (tens of thousands of rows) rewrites in well under a second and
--   │   nothing above is observable. If it has grown large, run the deploy in a QUIET
--   │   WINDOW — off-peak, with no notification burst in flight — so no channel job is
--   │   mid-delivery while the rewrite holds the lock.
--   ├─ ALTER COLUMN "recipient_id" DROP NOT NULL ─────────────────────────────────────
--   │ Always safe — no rewrite, no validation, strictly permissive.
--   ├─ ADD COLUMN "recipient_email" varchar(320) ─────────────────────────────────────
--   │ Nullable with no default → catalog-only, no rewrite. Always safe.
--   ├─ ADD CONSTRAINT "notification_log_recipient_exactly_one" CHECK (…) ─────────────
--   │ VALIDATED AGAINST EVERY EXISTING ROW at ADD time, so this is the one statement that
--   │ could reject the migration on a non-empty database.
--   │ SAFE BECAUSE: `recipient_id` was NOT NULL until two statements earlier, so EVERY
--   │ pre-existing row has `recipient_id IS NULL = false`; and `recipient_email` was added
--   │ one statement earlier as nullable-with-no-default, so EVERY pre-existing row has
--   │ `recipient_email IS NULL = true`. The predicate is `false <> true` = TRUE for all of
--   │ them, universally, with no dependence on what the data happens to contain.
--   │ ⚠ STATEMENT ORDER IS LOAD-BEARING: the CHECK must come AFTER the ADD COLUMN. It
--   │ does (last statement in the file). Do not reorder.
--   └─────────────────────────────────────────────────────────────────────────────────
--
-- `scheduled_notifications` is a brand-new table — nothing to reason about there.
--
-- ─────────────────────────────────────────────────────────────────────────────────────
-- ENUM HAZARDS
--
-- Both enums are BRAND-NEW `CREATE TYPE`s whose values are then used as a column DEFAULT
-- and inside index predicates in the SAME transaction (drizzle runs a migration's
-- statements as one transaction). That is LEGAL. The documented hazard (memory
-- `reference_enum_default_same_tx_migration_hazard`) is specific to `ALTER TYPE … ADD
-- VALUE` — a value added to a PRE-EXISTING type cannot be used until its transaction
-- commits. Creating a type and using its labels in the same transaction has no such
-- restriction, so NO `::text::enum` workaround is applied here. Proven by the integration
-- harness, which migrates from zero.
--
-- ⚠ FORWARD CONSTRAINT this file creates: `scheduled_notification_status` labels appear in
-- THREE index predicates below. Any future `ALTER TYPE … ADD VALUE` on it is still safe on
-- its own, but the NEW value may not be used (in a predicate, a default, or a data
-- statement) in the SAME migration — split it across two.

CREATE TYPE "public"."scheduled_notification_mode" AS ENUM('first_wins', 'replace_pending');--> statement-breakpoint
CREATE TYPE "public"."scheduled_notification_status" AS ENUM('pending', 'claimed', 'published', 'cancelled', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "scheduled_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"event" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "scheduled_notification_status" DEFAULT 'pending' NOT NULL,
	"mode" "scheduled_notification_mode" DEFAULT 'first_wins' NOT NULL,
	"recheck" varchar(100),
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"skip_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "scheduled_notification_dedupe_key_nonempty" CHECK (length(btrim("scheduled_notifications"."dedupe_key")) > 0),
	CONSTRAINT "scheduled_notification_attempts_nonneg" CHECK ("scheduled_notifications"."attempts" >= 0)
);
--> statement-breakpoint
-- BAL-341 (ADR-1047 Decision 8) — see the per-statement safety argument in the header.
-- HAND-EDIT A: `USING "correlation_id"::text` added to the drizzle-generated retype.
ALTER TABLE "notification_log" ALTER COLUMN "correlation_id" SET DATA TYPE text USING "correlation_id"::text;--> statement-breakpoint
ALTER TABLE "notification_log" ALTER COLUMN "recipient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_log" ADD COLUMN "recipient_email" varchar(320);--> statement-breakpoint
-- THE DEDUP TUPLE. Partial on BOTH `status = 'pending'` AND `deleted_at IS NULL`; the
-- repository's `ON CONFLICT … WHERE` arbiter restates this predicate BYTE-FOR-BYTE, with
-- the literal inlined rather than parameterised (a `$n` Param never satisfies Postgres's
-- predicate-implication proof against the index's Const, and the upsert would fail 42P10).
CREATE UNIQUE INDEX "scheduled_notification_pending_key_idx" ON "scheduled_notifications" USING btree ("dedupe_key") WHERE "scheduled_notifications"."status" = 'pending' AND "scheduled_notifications"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "scheduled_notification_due_idx" ON "scheduled_notifications" USING btree ("scheduled_for") WHERE "scheduled_notifications"."status" = 'pending' AND "scheduled_notifications"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "scheduled_notification_claimed_idx" ON "scheduled_notifications" USING btree ("claimed_at") WHERE "scheduled_notifications"."status" = 'claimed' AND "scheduled_notifications"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "scheduled_notification_key_idx" ON "scheduled_notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_log_recipient_email_idx" ON "notification_log" USING btree ("recipient_email");--> statement-breakpoint
-- MUST stay last: it validates against every existing row, and it can only pass because
-- the ADD COLUMN above already gave every pre-existing row `recipient_email IS NULL`.
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_recipient_exactly_one" CHECK (("notification_log"."recipient_id" IS NULL) <> ("notification_log"."recipient_email" IS NULL));
