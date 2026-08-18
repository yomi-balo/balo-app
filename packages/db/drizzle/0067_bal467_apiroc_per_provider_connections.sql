-- BAL-467 — Apiroc calendar foundation: per-provider connection model.
-- ADR-1021, amendment 18 Aug 2026 §1: "A calendar connection is per (expert, provider) …
-- unique on (expertId, provider)". ONE migration, not expand-contract: calendar_connections
-- and calendar_sub_calendars are both EMPTY (0 rows, balo-dev), so there is no backfill and
-- no window in which old and new readers coexist.
--
-- The four DROP NOT NULLs are what make the table writable for Apiroc at all: an Apiroc row
-- stores only the end_user_account_id pointer (Balo holds no provider tokens), so it leaves
-- cronofy_sub / access_token / refresh_token / token_expires_at NULL and would otherwise
-- fail 23502. They are RELAXED, not DROPPED, because the live Cronofy writer still needs
-- them — dropping them is Cronofy removal, which is BAL-396.
--
-- ⚠ The new unique index is PARTIAL on deleted_at IS NULL. Disconnect soft-deletes, so a
-- non-partial unique would make reconnect-after-disconnect fail 23505 against an invisible
-- row. The repository's ON CONFLICT arbiter MUST restate this predicate as `targetWhere`
-- or every upsert raises 42P10 at plan time.
--
-- NOT TOUCHED HERE, deliberately: `status` and cal_conn_status_check. The credential-status
-- lifecycle (ACTIVE | EXPIRED | REVOKED) and the status → credential_status rename are
-- BAL-396 §2/§9 — the slice that introduces the reconnect detection giving those values
-- meaning. status already defaults to 'connected', so nothing here is blocked by it.
DROP INDEX "cal_conn_expert_profile_idx";--> statement-breakpoint
ALTER TABLE "calendar_connections" ALTER COLUMN "cronofy_sub" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ALTER COLUMN "access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ALTER COLUMN "refresh_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ALTER COLUMN "token_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "end_user_account_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_conn_expert_provider_idx" ON "calendar_connections" USING btree ("expert_profile_id","provider") WHERE "calendar_connections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cal_conn_end_user_account_idx" ON "calendar_connections" USING btree ("end_user_account_id") WHERE "calendar_connections"."deleted_at" IS NULL;