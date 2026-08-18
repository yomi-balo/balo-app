-- BAL-396 — Cronofy teardown. Generated and applied AFTER the Apiroc path is complete and
-- green (see the build sequence): merging this before the Apiroc path works leaves the
-- platform with no calendar integration at all.
--
-- ⚠⚠ PRE-FLIGHT GATE, RUN BY A HUMAN BEFORE APPLYING — the empty-container harness cannot
-- reach this hazard:
--     SELECT count(*) FROM calendar_connections WHERE end_user_account_id IS NULL;
--   0  → proceed (expected: migration 0067's header records the table held 0 rows).
--   >0 → STOP. Those are Cronofy-era rows. They cannot be migrated (Balo never held an
--        Apiroc pointer for them) and they cannot survive step 3 below. The runbook step is
--        to notify those experts to reconnect, then re-run this gate. Do NOT "fix" this by
--        leaving the column nullable — a live row with no pointer is invisible to
--        `listBusyReadTargets`, so the expert shows as connected and is permanently
--        unreadable, which §9.4's fail-closed rule turns into "permanently unbookable".

-- 1. PRE-FLIGHT GATE, MADE EXECUTABLE (BAL-396 fix round, Finding 3) — the comment above used
--    to be the only enforcement, which means a `pnpm db:migrate` run that skips the header
--    could otherwise reach step 3 below with live Cronofy-era rows still in the table (a NOT
--    NULL added under them would simply fail — but only THAT far, after every other change in
--    this migration had already applied). This turns the check into a loud abort BEFORE
--    anything else runs: the migration REFUSES rather than proceeding on an unmet precondition.
--
--    ⚠⚠ FIX ROUND 2, Finding 8 — there is deliberately NO DELETE here. A round-1 draft of this
--    migration paired this gate with `DELETE FROM calendar_connections WHERE
--    end_user_account_id IS NULL` as "step 2" — but by construction that DELETE could only ever
--    run once this gate had already proven the WHERE clause matches zero rows (any match makes
--    the gate RAISE and abort the whole transaction first). A statement provably deleting
--    nothing is dead code that documents intent it does not perform; the gate's own RAISE
--    message is the actual enforcement, and the runbook note in the header above is where the
--    real removal path (reconnect, then re-run this gate) is described.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "calendar_connections" WHERE "end_user_account_id" IS NULL) THEN
    RAISE EXCEPTION 'BAL-396 pre-flight gate: Cronofy-era rows present — run the reconnect runbook first';
  END IF;
END $$;--> statement-breakpoint

-- 2. Drop the Cronofy identity columns and their indexes.
DROP INDEX "cal_conn_cronofy_sub_idx";--> statement-breakpoint
DROP INDEX "cal_conn_channel_id_idx";--> statement-breakpoint
ALTER TABLE "calendar_connections" DROP COLUMN "cronofy_sub";--> statement-breakpoint
ALTER TABLE "calendar_connections" DROP COLUMN "access_token";--> statement-breakpoint
ALTER TABLE "calendar_connections" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "calendar_connections" DROP COLUMN "token_expires_at";--> statement-breakpoint
ALTER TABLE "calendar_connections" DROP COLUMN "channel_id";--> statement-breakpoint

-- 3. The pointer is now the ONLY vendor identity, so it is mandatory (ADR-1021 amendment
--    18 Aug 2026 §5). Safe only because of the pre-flight gate in step 1.
ALTER TABLE "calendar_connections" ALTER COLUMN "end_user_account_id" SET NOT NULL;--> statement-breakpoint

-- 4. Orphan columns on expert_profiles — zero readers, zero writers (see plan §3.5).
ALTER TABLE "expert_profiles" DROP COLUMN "cronofy_user_id";--> statement-breakpoint
ALTER TABLE "expert_profiles" DROP COLUMN "cronofy_sync_status";
