import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-478 (R7) — `bookIntroCallAction` (`book-intro-call.ts`) carries NO money, ANYWHERE
 * (Ruling 2, a separate module from `book-consultation.ts`). BAL-478 added the funding
 * pre-condition to the CASE-booking path only; this pins that the intro-call path is
 * structurally unaffected — proven with a test, per R7, rather than by leaving the file
 * unedited and hoping.
 */
const ACTIONS_DIR = resolveRouteDir([
  'src/lib/booking/actions',
  'apps/web/src/lib/booking/actions',
]);

const FORBIDDEN_MONEY_REFERENCES = [
  'booking-funding-gate',
  'enforceBookingFunding',
  '@balo/shared/credit',
  'creditWalletsRepository',
  'creditHoldsRepository',
];

describe('invariant: book-intro-call.ts carries no money (BAL-478 / R7)', () => {
  it('collects the actions directory, including both named files (guards against a vacuous pass)', () => {
    expect(ACTIONS_DIR).not.toBe('');
    const scanned = scanRouteSources(ACTIONS_DIR, 'actions', []);
    const rel = scanned.map((file) => file.rel);
    expect(rel).toContain('actions/book-intro-call.ts');
    expect(rel).toContain('actions/book-consultation.ts');
  });

  it('⚠ book-intro-call.ts references none of the funding-gate money surfaces', () => {
    const scanned = scanRouteSources(ACTIONS_DIR, 'actions', []);
    const introCall = scanned.find((file) => file.rel === 'actions/book-intro-call.ts');
    if (introCall === undefined) throw new Error('book-intro-call.ts not found by the scan');

    const offenders = FORBIDDEN_MONEY_REFERENCES.filter((needle) =>
      introCall.code.includes(needle)
    );
    expect(
      offenders,
      `book-intro-call.ts references the funding gate's money surfaces, which R7 forbids:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * ⚠⚠ THE MUTATION PROOF (guards the guard). The SAME scan over `book-consultation.ts` MUST
   * find these references — without this, a broken scanner (e.g. a typo'd needle, or a scan
   * that silently reads the wrong file) would make the assertion above pass for the wrong
   * reason, proving nothing. This is what would go red if someone wired the gate into the
   * intro-call path.
   */
  it('⚠ the mutation proof: the SAME scan DOES find the funding gate in book-consultation.ts', () => {
    const scanned = scanRouteSources(ACTIONS_DIR, 'actions', []);
    const bookConsultation = scanned.find((file) => file.rel === 'actions/book-consultation.ts');
    if (bookConsultation === undefined) {
      throw new Error('book-consultation.ts not found by the scan');
    }

    expect(bookConsultation.code).toContain('booking-funding-gate');
    expect(bookConsultation.code).toContain('enforceBookingFunding');
  });
});
