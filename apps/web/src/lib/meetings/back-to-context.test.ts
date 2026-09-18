import { describe, expect, it } from 'vitest';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import {
  DASHBOARD_BACK_TO,
  resolveBackTo,
  resolveContextNoun,
  type BackToSubject,
} from './back-to-context';

/**
 * ⚠ TOTAL BY CONSTRUCTION, NOT BY A SEPARATE ASSERTION. `satisfies Record<…, true>` requires a
 * key for EVERY holder-bearing label, so adding a seventh and forgetting it here fails to
 * compile — and the guard is the object's own type, so there is nothing to keep in sync and
 * nothing to re-assert at runtime.
 *
 * ⚠ THIS REPLACED AN `expect(_assertTotal).toBe(true)` THAT COULD ONLY EVER PASS: `_assertTotal`
 * was a `const` whose declared type WAS `true`. The compile-time check was real; its runtime
 * echo asserted nothing while making the test look guarded.
 */
const ALL_WITH_HOLDER = Object.keys({
  case: true,
  project_discovery: true,
  project_kickoff: true,
  package_session: true,
  retainer_checkin: true,
  request_interaction: true,
} satisfies Record<MeetingContextTypeWithHolder, true>) as MeetingContextTypeWithHolder[];

/**
 * BAL-567 — a RESOLVED subject: the owning row was verified, and the request-grain arms carry
 * the resolved `projectRequestId` rather than the polymorphic `contextId`.
 *
 * ⚠ `projectRequestId` DEFAULTS TO `null`, NOT TO `contextId`. Defaulting it to the context id
 * would quietly reinstate the very bug this consolidation fixed, inside the test helper, where
 * it would be hardest to see.
 */
function subject(
  contextType: MeetingContextTypeWithHolder,
  contextId: string,
  projectRequestId: string | null = null
): BackToSubject {
  return { owningRowFound: true, contextType, contextId, projectRequestId };
}

describe('resolveBackTo', () => {
  it('answers for every holder-bearing context type, with a non-empty label and href', () => {
    /**
     * ⚠ THE LOOP IS GUARDED BY A COUNT, NOT BY A TAUTOLOGY. This previously closed with
     * `expect(_assertTotal).toBe(true)`, which can only ever pass: `_assertTotal` is a `const`
     * whose declared type IS `true`. The real totality check is the compile-time annotation on
     * that const — a runtime echo of it asserted nothing, while making the test LOOK guarded.
     * What actually needed guarding is the loop: over an empty list every assertion below is
     * skipped and the test still passes green.
     */
    expect(ALL_WITH_HOLDER).toHaveLength(6);

    for (const contextType of ALL_WITH_HOLDER) {
      // Every arm is fed its own resolved request id, so the two request-grain labels have a
      // target and the loop is about totality rather than about the null-target arms.
      const backTo = resolveBackTo(subject(contextType, 'ctx-1', 'req-1'));
      expect(backTo.label.length).toBeGreaterThan(0);
      expect(backTo.href.startsWith('/')).toBe(true);
    }
  });

  /**
   * BAL-567 — `case` NOW LANDS ON `/cases/{engagementId}`.
   *
   * It pointed at the constant `/consultations` for as long as `/cases/[caseId]` did not exist.
   * BAL-421 built that route, and BAL-567 makes `/consultations` a permanent redirect to
   * `/cases`, so the old target is now one hop from where the member actually wants to be — and,
   * worse, the INDEX rather than THIS case.
   */
  it('BAL-567 — points `case` at /cases/{engagementId}, never the old /consultations index', () => {
    const backTo = resolveBackTo(subject('case', 'case-1'));
    expect(backTo).toEqual({ label: 'Back to the case', href: '/cases/case-1' });
    expect(backTo.href).not.toBe('/consultations');
  });

  it('renders no /consultations link for any context', () => {
    expect(ALL_WITH_HOLDER).toHaveLength(6);
    for (const contextType of ALL_WITH_HOLDER) {
      expect(resolveBackTo(subject(contextType, 'ctx-1', 'req-1')).href).not.toContain(
        '/consultations'
      );
    }
  });

  /**
   * BAL-567 / D1 — THE WRONG-ID BUG, PINNED.
   *
   * `request_interaction`'s `contextId` is a `request_expert_relationships.id`, NOT a request id.
   * The old table built `/projects/{contextId}` from it and sent the member to a request that
   * was not theirs. The negative assertion is the load-bearing half: the positive one passes
   * just as happily against a table that ignores `projectRequestId` when the two ids are
   * accidentally equal, which is exactly how a fixture would be written by someone unaware of
   * the distinction.
   */
  it('BAL-567 — routes request_interaction via the RESOLVED request id, never the relationship id', () => {
    const backTo = resolveBackTo(subject('request_interaction', 'relationship-1', 'request-9'));
    expect(backTo).toEqual({ label: 'Back to the request', href: '/projects/request-9' });
    expect(backTo.href).not.toContain('relationship-1');
  });

  it('routes project_discovery via the resolved request id too', () => {
    // On this arm `contextId` IS the request id, but the resolved column is still what is read —
    // one rule for both request-grain labels, not two.
    expect(resolveBackTo(subject('project_discovery', 'r1', 'r1'))).toEqual({
      label: 'Back to the project request',
      href: '/projects/r1',
    });
  });

  it('BAL-567 — a request-grain arm with NO resolved request falls back, never guesses', () => {
    // The fail-closed half of the fix: with nothing resolved there is no honest link, so the
    // member gets the dashboard rather than `/projects/{relationshipId}`.
    expect(resolveBackTo(subject('request_interaction', 'relationship-1', null))).toEqual(
      DASHBOARD_BACK_TO
    );
    expect(resolveBackTo(subject('project_discovery', 'r1', null))).toEqual(DASHBOARD_BACK_TO);
  });

  it('routes project_kickoff to /engagements/{id}', () => {
    expect(resolveBackTo(subject('project_kickoff', 'e1'))).toEqual({
      label: 'Back to the project',
      href: '/engagements/e1',
    });
  });

  /**
   * BAL-567 — `package_session` / `retainer_checkin` NOW FALL BACK, AND THAT IS A FIX.
   *
   * They used to render `/engagements/{contextId}`, which 404s: those ids are not project
   * engagements and no `/packages/…` or `/retainers/…` route exists. Both kinds are
   * declared-but-unbuilt, so no live row was ever affected — but the link was wrong, not merely
   * unbuilt, and `hrefForMeeting` has always answered `null` for them.
   */
  it('BAL-567 — the two unbuilt delivery kinds fall back to the dashboard, not a 404 href', () => {
    expect(resolveBackTo(subject('package_session', 'e1'))).toEqual(DASHBOARD_BACK_TO);
    expect(resolveBackTo(subject('retainer_checkin', 'e1'))).toEqual(DASHBOARD_BACK_TO);
  });

  it('⚠ falls back to the dashboard for a null context (a guest, or an unresolved one)', () => {
    expect(resolveBackTo(null)).toEqual(DASHBOARD_BACK_TO);
    expect(DASHBOARD_BACK_TO.href).toBe('/dashboard');
  });

  it('BAL-567 — an UNVERIFIED owning row yields the fallback on every arm', () => {
    // `owningRowFound: false` is the repository's "this `meeting_contexts.context_id` resolved to
    // nobody" answer. Rendering it would leak another tenant's identifier into this viewer's page.
    expect(ALL_WITH_HOLDER).toHaveLength(6);
    for (const contextType of ALL_WITH_HOLDER) {
      expect(
        resolveBackTo({
          owningRowFound: false,
          contextType,
          contextId: 'ctx-1',
          projectRequestId: 'req-1',
        })
      ).toEqual(DASHBOARD_BACK_TO);
    }
  });

  it('uses sentence case, so assistive tech does not spell the label out', () => {
    expect(ALL_WITH_HOLDER).toHaveLength(6);
    for (const contextType of ALL_WITH_HOLDER) {
      const { label } = resolveBackTo(subject(contextType, 'ctx-1', 'req-1'));
      expect(label).not.toBe(label.toUpperCase());
      expect(label.startsWith('Back to ')).toBe(true);
    }
  });
});

describe('resolveContextNoun', () => {
  it('answers a bare noun for every context type', () => {
    const nouns = ALL_WITH_HOLDER.map((contextType) =>
      resolveContextNoun(subject(contextType, 'x'))
    );
    expect(nouns).toEqual(['case', 'request', 'project', 'package', 'retainer', 'request']);
  });

  /**
   * ⚠ THE NOUN IS INDEPENDENT OF WHETHER A PAGE EXISTS. `package_session` has no reachable
   * route, so `resolveBackTo` falls back to the dashboard — but the confirm dialog must still
   * say "…stay with the package", because that is what the meeting belongs to. Wiring the noun
   * through `hrefForMeeting` too would have made it say "call" here, which is vaguer than the
   * truth we hold.
   */
  it('BAL-567 — still names the context even when it has no reachable page', () => {
    expect(resolveContextNoun(subject('package_session', 'e1'))).toBe('package');
    expect(resolveBackTo(subject('package_session', 'e1'))).toEqual(DASHBOARD_BACK_TO);
  });

  it('⚠ falls back to "call" rather than guessing a context on a destructive confirm', () => {
    expect(resolveContextNoun(null)).toBe('call');
  });
});
