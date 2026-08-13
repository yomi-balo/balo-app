import { describe, expect, it } from 'vitest';
import { resolveWaitingSubject } from './waiting-subject';

/**
 * BAL-435 (ruling R10) — the client half of "who is missing".
 *
 * ⚠⚠ THE DEFECT THIS PINS: the frame hard-coded `absentParty="expert"` for every viewer, so an
 * EXPERT alone in the room read the CLIENT's "You won't be charged for waiting" — a sentence with
 * no meaning on the side that gets PAID, at the exact moment BAL-134 says an expert walks out and
 * forfeits a settlement.
 */

const LABEL = '10:00 am';

describe('resolveWaitingSubject — the viewer decides who is absent', () => {
  it('⚠ a CLIENT viewer is waiting for the EXPERT', () => {
    expect(
      resolveWaitingSubject({
        viewerRole: 'client',
        counterpartyFirstName: 'Dana',
        scheduledStartLabel: LABEL,
      })
    ).toEqual({ absentParty: 'expert', counterpartyFirstName: 'Dana', scheduledStartLabel: LABEL });
  });

  it('⚠⚠ an EXPERT viewer is waiting for the CLIENT — the branch that was unreachable', () => {
    expect(
      resolveWaitingSubject({
        viewerRole: 'expert',
        counterpartyFirstName: 'Northwind Industrial',
        scheduledStartLabel: LABEL,
      })
    ).toEqual({
      absentParty: 'client',
      counterpartyFirstName: 'Northwind Industrial',
      scheduledStartLabel: LABEL,
    });
  });
});

describe('resolveWaitingSubject — ⚠⚠ all three pieces, or none', () => {
  it('no viewer role ⇒ null (both GUEST mounts, structurally)', () => {
    expect(
      resolveWaitingSubject({
        viewerRole: null,
        counterpartyFirstName: 'Dana',
        scheduledStartLabel: LABEL,
      })
    ).toBeNull();
  });

  it('no counterparty name ⇒ null, never "your expert" as a literal', () => {
    expect(
      resolveWaitingSubject({
        viewerRole: 'client',
        counterpartyFirstName: null,
        scheduledStartLabel: LABEL,
      })
    ).toBeNull();
  });

  it('no scheduled start ⇒ null, never "the scheduled time" as a literal', () => {
    // Both placeholders shipped once. A subject that can be HALF supplied is how.
    expect(
      resolveWaitingSubject({
        viewerRole: 'client',
        counterpartyFirstName: 'Dana',
        scheduledStartLabel: null,
      })
    ).toBeNull();
  });
});
