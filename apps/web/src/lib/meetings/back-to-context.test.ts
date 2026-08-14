import { describe, expect, it } from 'vitest';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import { DASHBOARD_BACK_TO, resolveBackTo, resolveContextNoun } from './back-to-context';

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
      const backTo = resolveBackTo({ contextType, contextId: 'ctx-1' });
      expect(backTo.label.length).toBeGreaterThan(0);
      expect(backTo.href.startsWith('/')).toBe(true);
    }
  });

  it('⚠ points `case` at /consultations — /cases/[caseId] is BAL-421 and does not exist yet', () => {
    expect(resolveBackTo({ contextType: 'case', contextId: 'case-1' })).toEqual({
      label: 'Back to the case',
      href: '/consultations',
    });
  });

  it('never renders a /cases/… dead link for any context', () => {
    for (const contextType of ALL_WITH_HOLDER) {
      expect(resolveBackTo({ contextType, contextId: 'ctx-1' }).href).not.toContain('/cases/');
    }
  });

  it('routes the two request-grain contexts to /projects/{id}', () => {
    expect(resolveBackTo({ contextType: 'project_discovery', contextId: 'r1' })).toEqual({
      label: 'Back to the project request',
      href: '/projects/r1',
    });
    expect(resolveBackTo({ contextType: 'request_interaction', contextId: 'r1' })).toEqual({
      label: 'Back to the request',
      href: '/projects/r1',
    });
  });

  it('routes the three delivery contexts to /engagements/{id}', () => {
    expect(resolveBackTo({ contextType: 'project_kickoff', contextId: 'e1' })).toEqual({
      label: 'Back to the project',
      href: '/engagements/e1',
    });
    expect(resolveBackTo({ contextType: 'package_session', contextId: 'e1' })).toEqual({
      label: 'Back to the package',
      href: '/engagements/e1',
    });
    expect(resolveBackTo({ contextType: 'retainer_checkin', contextId: 'e1' })).toEqual({
      label: 'Back to the retainer',
      href: '/engagements/e1',
    });
  });

  it('⚠ falls back to the dashboard for a null context (a guest, or an unresolved one)', () => {
    expect(resolveBackTo(null)).toEqual(DASHBOARD_BACK_TO);
    expect(DASHBOARD_BACK_TO.href).toBe('/dashboard');
  });

  it('uses sentence case, so assistive tech does not spell the label out', () => {
    for (const contextType of ALL_WITH_HOLDER) {
      const { label } = resolveBackTo({ contextType, contextId: 'ctx-1' });
      expect(label).not.toBe(label.toUpperCase());
      expect(label.startsWith('Back to ')).toBe(true);
    }
  });
});

describe('resolveContextNoun', () => {
  it('answers a bare noun for every context type', () => {
    const nouns = ALL_WITH_HOLDER.map((contextType) =>
      resolveContextNoun({ contextType, contextId: 'x' })
    );
    expect(nouns).toEqual(['case', 'request', 'project', 'package', 'retainer', 'request']);
  });

  it('⚠ falls back to "call" rather than guessing a context on a destructive confirm', () => {
    expect(resolveContextNoun(null)).toBe('call');
  });
});
