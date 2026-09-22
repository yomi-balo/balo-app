-- Expert schedule timezone ← the timezone the expert chose at onboarding.
--
-- `expert_profiles.timezone` was created with the column's bare 'UTC' default instead of the
-- user's own `users.timezone` (fixed in `expertsRepository.findOrCreateDraft`). This copies the
-- onboarding choice onto every profile still sitting on that untouched default.
--
-- ⚠ WHY "profile = 'UTC' AND user ≠ 'UTC'" CAN ONLY MEAN "NEVER SET". Once a profile exists,
-- `users.timezone` is written only by the two schedule routes (apps/api routes/experts/
-- schedule.ts), and both set `expert_profiles.timezone` to the same value in the same
-- transaction. An expert who deliberately chose UTC therefore has `users.timezone = 'UTC'` too,
-- and is not matched here. The only other writer, onboarding's timezone step, runs before the
-- profile is created.
--
-- The integration harness migrates an EMPTY database, so this touches 0 rows there.
UPDATE "expert_profiles" AS ep
SET "timezone" = u."timezone",
    "updated_at" = now()
FROM "users" AS u
WHERE ep."user_id" = u."id"
  AND ep."timezone" = 'UTC'
  AND u."timezone" IS NOT NULL
  AND u."timezone" <> 'UTC'
  AND u."deleted_at" IS NULL;
