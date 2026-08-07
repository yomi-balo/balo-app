import { describe, it, expect } from 'vitest';
import { meetingContextTypeEnum } from '../schema/enums';

/**
 * BAL-413 / ADR-1046 — RUNTIME ENUM-DRIFT GUARD for `meeting_context_type`.
 *
 * This is the runtime pair to the compile-time exhaustiveness `never` in BAL-413's
 * resolver switch (`apps/api/src/services/meetings/authorize-engagement-host.ts`). It exists
 * because the two ends of that pair fail differently and a label change must trip BOTH:
 *
 *   · the resolver's `const exhaustive: never = subject;` tail catches an 8th label at
 *     `pnpm --filter api typecheck` — but ONLY for a consumer that switches exhaustively.
 *     Nothing forces a future consumer to switch at all, and nothing at all guards the
 *     ORDER of the labels.
 *   · this test catches ANY edit to the label set — added, removed, renamed, or REORDERED —
 *     at `TZ=UTC npx vitest run packages/db/src/invariants`, i.e. in `packages/db`, where the
 *     change is actually made. `@balo/db` has no `typecheck` script, so a type-level
 *     assertion placed here would be vacuously green; a runtime assertion is not.
 *
 * ⚠⚠ IF THIS TEST FAILS, DO NOT JUST UPDATE THE EXPECTED LIST. An 8th label must sweep:
 *   1. `apps/api/src/services/meetings/authorize-engagement-host.ts` — the exhaustive
 *      `switch (subject.contextType)` that resolves the engagement-capability holder set
 *      (BAL-413 / ADR-1046 §3). A label with NO arm has NO holder rule; a label given the
 *      WRONG arm hands meeting-host rights to the wrong expert. This is the security-relevant
 *      sweep and the reason this guard exists.
 *   2. `../repositories/_shared/consultation-projection.ts` — BOTH `loadContextExperts`
 *      and `resolveOneContext`. ⚠ NEITHER IS A `switch`, so NOTHING TYPECHECKS THIS ONE:
 *      both end in an `else` that treats `context_id` as an `engagements.id`, so a new
 *      label with no arm is looked up in the WRONG TABLE and hard-fails the whole booking
 *      transaction (this is precisely what `request_interaction` did before BAL-413 gave
 *      it an explicit `not_projectable` arm). A new label needs a deliberate answer:
 *      project it, ignore it, or `MeetingContextNotProjectableError`.
 *   3. `../repositories/meeting-presence.ts` — `listClientUserIdsForEngagement`'s
 *      `inArray(meetingContexts.contextType, [...])` ALLOW-LIST. It names the four
 *      engagement-grain labels explicitly, so a new label is silently EXCLUDED. That is
 *      the correct default (the function reads engagement-grain contexts only, and
 *      `request_interaction` is at request-relationship grain, so excluding it is right)
 *      — but it is silent, so a new engagement-grain label would silently drop client
 *      participants from a notification fan-out. Decide, do not inherit.
 *   4. The polymorphic map docblock above `meetingContextTypeEnum` in `../schema/enums.ts` —
 *      a label whose `context_id` target is undocumented is a dangling pointer by design
 *      (`meeting_contexts.context_id` has NO FK; see `../schema/meeting-contexts.ts`).
 *   5. The `meeting_context_admin_no_id` CHECK (`context_id IS NULL ⟺ context_type='admin'`).
 *      A new NON-admin label inherits the correct half automatically and needs no CHECK
 *      change; a second id-less label WOULD need one.
 *
 * ⚠ ITEMS 2 AND 3 ARE THE SILENT ONES. Item 1 fails at `pnpm --filter api typecheck`;
 * items 2 and 3 fail at RUNTIME, in production, on the first row written with the new
 * label. That asymmetry is why they are named here rather than left to the compiler.
 *
 * ⚠ ORDER IS ASSERTED ON PURPOSE, not incidentally. `toEqual` on an array pins the ordinals:
 * Postgres `ALTER TYPE … ADD VALUE` appends, so a label inserted MID-ARRAY makes drizzle
 * attempt to RECREATE the type rather than emit a plain additive `ADD VALUE`. Append only.
 */

/**
 * The 7 labels of `meeting_context_type`, in DECLARED ORDER, as of BAL-413 (migration
 * `0060_bal413_request_interaction_context`). Six shipped with ADR-1045; `request_interaction`
 * is the seventh (ADR-1046 amendment 2026-08-07, at `request_expert_relationships` grain).
 */
const EXPECTED_MEETING_CONTEXT_TYPES: readonly string[] = [
  'case',
  'project_discovery',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'admin',
  'request_interaction',
];

describe('invariant: meeting_context_type label set (BAL-413 / ADR-1046)', () => {
  it('resolves the pgEnum and it is still the meeting_context_type enum (non-vacuity guard)', () => {
    // Guard the guard: if the import ever resolved to something without `enumValues`, the
    // assertions below would compare `undefined` and could go quietly green.
    expect(meetingContextTypeEnum.enumName).toBe('meeting_context_type');
    expect(Array.isArray(meetingContextTypeEnum.enumValues)).toBe(true);
  });

  it('declares EXACTLY the 7 expected labels, in order', () => {
    expect(meetingContextTypeEnum.enumValues).toEqual(EXPECTED_MEETING_CONTEXT_TYPES);
  });

  it('declares `request_interaction` LAST — appended, never inserted mid-array', () => {
    // The ordinal-stability half, stated separately so a mid-array insert names itself in
    // the failure output rather than showing up as a whole-array diff.
    expect(meetingContextTypeEnum.enumValues.at(-1)).toBe('request_interaction');
    expect(meetingContextTypeEnum.enumValues.indexOf('admin')).toBe(
      meetingContextTypeEnum.enumValues.length - 2
    );
  });

  it('declares no duplicate label', () => {
    expect(new Set(meetingContextTypeEnum.enumValues).size).toBe(
      meetingContextTypeEnum.enumValues.length
    );
  });
});
