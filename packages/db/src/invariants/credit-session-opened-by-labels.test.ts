import { describe, expect, it } from 'vitest';
import { CREDIT_SESSION_OPENED_BY } from '@balo/shared/credit';
import { creditSessionOpenedByEnum } from '../schema/enums';

/**
 * BAL-474 (ADR-1040 Amendment 7 §C, plan AD-5) — CROSS-PACKAGE VOCABULARY PIN for
 * `credit_sessions.opened_by`.
 *
 * `@balo/shared/credit` carries `CREDIT_SESSION_OPENED_BY` because `@balo/shared` cannot import
 * `@balo/db`'s enum (the dependency direction is `@balo/db → @balo/shared`, never the reverse),
 * and `SettleableSession.openedBy` / the analytics `opened_by` property are typed from it. Nothing
 * typechecks the tuple against the column's real vocabulary, so a label added to one side only
 * would make every publisher keyed on `openedBy !== 'client'` (the D5.7 membership gate) silently
 * mis-classify a session. This file is the check the compiler cannot make.
 *
 * Three labels, not the ticket's two (plan OQ-3): `client` = a client company member acted;
 * `guest` = a client-side, email-invited guest's admission, on behalf of the booker; `system` = a
 * terminal path or the durability backstop, on behalf of the booker.
 */
describe('INVARIANT: credit_session_opened_by labels are one vocabulary across packages', () => {
  it('the pgEnum and the shared label tuple are the same set, in the same order', () => {
    const dbLabels: readonly string[] = creditSessionOpenedByEnum.enumValues;
    const sharedLabels: readonly string[] = CREDIT_SESSION_OPENED_BY;
    // Guard a vacuous pass: both sides resolve and are non-empty.
    expect(dbLabels.length).toBeGreaterThan(0);
    expect(sharedLabels).toEqual(dbLabels);
    expect(dbLabels).toEqual(['client', 'guest', 'system']);
  });
});
