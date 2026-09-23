-- Expert schedule timezone ← the timezone the expert chose at onboarding.
--
-- `expert_profiles.timezone` was created with the column's bare 'UTC' default instead of the
-- user's own `users.timezone` (fixed in `expertsRepository.findOrCreateDraft`). This copies the
-- onboarding choice onto every profile still sitting on that untouched default.
--
-- ⚠ WHY "profile = 'UTC' AND user ≠ 'UTC'" CAN ONLY MEAN "NEVER SET". Once a profile exists,
-- `users.timezone` is written only by the two schedule routes — both calls to
-- `usersRepository.updateTimezone` inside a transaction that also sets `expert_profiles.timezone`
-- to the same value (`apps/api/src/routes/experts/schedule.ts:234,333`). An expert who
-- deliberately chose UTC therefore has `users.timezone = 'UTC'` too, and is not matched here.
--
-- The only OTHER writer is `updateTimezoneAction` (apps/web/src/lib/auth/actions/update-timezone
-- .ts, called from the onboarding wizard's `timezone-step.tsx`), and it runs before any profile
-- exists: `expert_profiles` rows are created only from `findOrCreateDraft`, itself reachable only
-- through the expert-application flow, which the middleware onboarding gate
-- (`middleware.ts:175-185`) refuses until `onboardingCompleted === true` — and nothing in the
-- codebase ever resets that flag back to `false` for an existing user. Verified by grepping every
-- `usersRepository.update(...)` call site for a `timezone` field (2026-09-23): only the schedule
-- routes and this one onboarding action write it, confirming no third writer can race the
-- profile's creation.
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
