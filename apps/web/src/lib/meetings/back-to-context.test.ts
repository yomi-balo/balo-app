import { describe, expect, it } from 'vitest';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import { DASHBOARD_BACK_TO, resolveBackTo, resolveContextNoun } from './back-to-context';

/**
 * ⚠ DRIVEN FROM A LOCAL EXHAUSTIVE LIST that `tsc` proves complete: the `satisfies` below fails
 * to compile if a seventh holder-bearing label is added and not listed, so a new context type
 * fails HERE as well as at the lookup table.
 */
const ALL_WITH_HOLDER = [
  'case',
  'project_discovery',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'request_interaction',
] as const satisfies readonly MeetingContextTypeWithHolder[];

type Listed = (typeof ALL_WITH_HOLDER)[number];
/** ⚠ Fails to compile if a label exists that the list above forgot. */
type AssertTotal = MeetingContextTypeWithHolder extends Listed ? true : never;
const _assertTotal: AssertTotal = true;

describe('resolveBackTo', () => {
  it('answers for every holder-bearing context type, with a non-empty label and href', () => {
    for (const contextType of ALL_WITH_HOLDER) {
      const backTo = resolveBackTo({ contextType, contextId: 'ctx-1' });
      expect(backTo.label.length).toBeGreaterThan(0);
      expect(backTo.href.startsWith('/')).toBe(true);
    }
    expect(_assertTotal).toBe(true);
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
