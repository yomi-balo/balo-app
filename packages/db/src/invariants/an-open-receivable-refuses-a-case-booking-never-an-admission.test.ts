import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ⚠⚠ INVARIANT — AN OPEN RECEIVABLE REFUSES A NEW CASE BOOKING, AND NEVER AN ADMISSION.
 * ADR-1040 Amendment 7 §H (BAL-474, owner ruling D6.1).
 *
 * ADR-1040's "no new Cases until cleared" is RE-SCOPED, not withdrawn: the soft account hold (an
 * open `credit_receivables` row) now refuses a new Case BOOKING. Admission is never blocked
 * (BAL-466 D2) and the presence seam's open is overdraft-tolerant (Amendment 7 §B), so a
 * consultation already booked when a hold appears still runs and bills session-scoped. That
 * bounds carried exposure to the consultations already booked when the hold appeared.
 *
 * ⚠ THIS FILE CREATES THE INVARIANT. Per ADR-1032 it was AUTHORED AND RUN RED before the booking
 * verdict (`@balo/shared/credit` `assessCaseBookingFunding`), the one snapshot read
 * (`bookingFundingRepository.readSnapshot`) and the API guard (`checkCaseBookingFunding`) existed.
 *
 * Behavioural coverage lives elsewhere and is named here, not re-run: F2 (a tolerant open with a
 * receivable), F3 (a no-show with a receivable), the `routes/meetings` test (409), and
 * `booking-funding-gate.test.ts` (the hold arm).
 */

interface ScannedFile {
  displayPath: string;
  url: URL;
}

function file(displayPath: string, relativeToThisFile: string): ScannedFile {
  return { displayPath, url: new URL(relativeToThisFile, import.meta.url) };
}

function readScannedSourceOrFail({ displayPath, url }: ScannedFile): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-474 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        'an-open-receivable-refuses-a-case-booking-never-an-admission.test.ts rather than ' +
        `letting the scan silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

/** Comments removed — a docblock naming a call can neither satisfy nor break a scan. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Code-only, whitespace-normalised — survives a Prettier rewrap. */
function scan(target: ScannedFile): string {
  return codeOnly(readScannedSourceOrFail(target)).replace(/\s+/g, ' ');
}

/** The code between `startMarker` and the next top-level function declaration. */
function sliceFunction(code: string, startMarker: string): string {
  const start = code.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Marker not found: "${startMarker}"`);
  }
  const ends = [' export function ', ' export async function ', ' async function ', ' function ']
    .map((marker) => code.indexOf(marker, start + startMarker.length))
    .filter((index) => index !== -1);
  const end = ends.length === 0 ? code.length : Math.min(...ends);
  return code.slice(start, end);
}

const SHARED_VERDICT = file(
  'packages/shared/src/credit/booking-funding.ts',
  '../../../shared/src/credit/booking-funding.ts'
);
const DB_SNAPSHOT = file(
  'packages/db/src/repositories/booking-funding.ts',
  '../repositories/booking-funding.ts'
);
const WEB_GATE = file(
  'apps/web/src/lib/booking/booking-funding-gate.ts',
  '../../../../apps/web/src/lib/booking/booking-funding-gate.ts'
);
const API_GUARD = file(
  'apps/api/src/services/meetings/case-booking-funding.ts',
  '../../../../apps/api/src/services/meetings/case-booking-funding.ts'
);
const MEETINGS_ROUTE = file(
  'apps/api/src/routes/meetings/index.ts',
  '../../../../apps/api/src/routes/meetings/index.ts'
);
const JOIN_MEETING = file(
  'apps/api/src/services/meetings/join-meeting.ts',
  '../../../../apps/api/src/services/meetings/join-meeting.ts'
);
const OPEN_ON_BEHALF = file(
  'apps/api/src/services/credit-session/open-on-behalf-of-booker.ts',
  '../../../../apps/api/src/services/credit-session/open-on-behalf-of-booker.ts'
);
const SETTLE_SESSIONLESS = file(
  'apps/api/src/services/credit-session/settle-sessionless-case-meeting.ts',
  '../../../../apps/api/src/services/credit-session/settle-sessionless-case-meeting.ts'
);

describe('INVARIANT: an open receivable refuses a new Case BOOKING and never an ADMISSION (ADR-1040 Amendment 7 §H)', () => {
  it('the booking verdict checks the hold BEFORE the mandate short-circuit', () => {
    // A mandate holder whose settlements keep declining is precisely the population the brake
    // exists for — so the hold arm must run before an active mandate can wave the booking through.
    const verdict = sliceFunction(
      scan(SHARED_VERDICT),
      'export function assessCaseBookingFunding('
    );
    const holdIdx = verdict.indexOf("'account_on_hold'");
    const mandateIdx = verdict.indexOf("arm: 'mandate'");
    expect(holdIdx).toBeGreaterThanOrEqual(0);
    expect(mandateIdx).toBeGreaterThan(holdIdx);

    // …and the ONE snapshot reads the hold before it reads the mandate, so the verdict is never
    // handed a mandate short-circuit that skipped the hold read.
    const snapshot = scan(DB_SNAPSHOT);
    const holdReadIdx = snapshot.indexOf('readHoldStatus(');
    const mandateReadIdx = snapshot.indexOf('isWalletMandateActive(');
    expect(holdReadIdx).toBeGreaterThanOrEqual(0);
    expect(mandateReadIdx).toBeGreaterThan(holdReadIdx);
  });

  it('both booking checks use the one snapshot and the one verdict', () => {
    for (const target of [WEB_GATE, API_GUARD]) {
      const code = scan(target);
      expect(code, target.displayPath).toContain('readSnapshot(');
      expect(code, target.displayPath).toContain('assessCaseBookingFunding(');
      // A second, hand-rolled hold or balance read is how the two checks would drift apart.
      expect(code, target.displayPath).not.toContain('hasOpenReceivable(');
      expect(code, target.displayPath).not.toContain('getAvailableBalance(');
    }
  });

  it('the API guard runs after the classified replay probe, only for case, before the per-pair guards — anchored on the CALL sites', () => {
    // R2-F8 / D8.6 — anchored on the CALLS inside `resolveBookingInput`, never on an import line
    // or the service-error mapper (which already names `'idempotency_key_conflict'` further up the
    // file). Mutation proof: move the funding guard above the replay probe and this fails.
    const route = scan(MEETINGS_ROUTE);
    const pipeline = sliceFunction(route, 'async function resolveBookingInput(');
    const probeIdx = pipeline.indexOf('await lookupBookingReplay(');
    const conflictIdx = pipeline.indexOf("'idempotency_key_conflict'", probeIdx);
    const fundingIdx = pipeline.indexOf('checkCaseBookingFunding(', conflictIdx);
    const perPairIdx = pipeline.indexOf('await enforceExpertScopedGuards(', fundingIdx);
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(conflictIdx).toBeGreaterThan(probeIdx);
    expect(fundingIdx).toBeGreaterThan(conflictIdx);
    expect(perPairIdx).toBeGreaterThan(fundingIdx);
    // A lost-201 replay never reads a hold or a reservation; only a Case books against credit.
    expect(pipeline).toContain("!replaying && contextType === 'case'");
    // The boolean probe is gone — one classified probe answers match / conflict / none.
    expect(route).not.toContain('isExactBookingReplay(');
  });

  it('a covered hold is healed at booking, never shown', () => {
    // D8.1 — a hold whose debt the balance already covers is cleared by the API guard, which then
    // re-runs the verdict. The web gate defers (`onCoveredHold`) and never clears anything itself:
    // the coverage decision keeps its one home in `apps/api/src/services/credit/receivable-coverage.ts`.
    const guard = scan(API_GUARD);
    const healIdx = guard.indexOf('healCoveredHoldNow(');
    expect(healIdx).toBeGreaterThanOrEqual(0);
    expect(guard.indexOf('assessCaseBookingFunding(', healIdx)).toBeGreaterThan(healIdx);

    const gate = scan(WEB_GATE);
    expect(gate).toContain('onCoveredHold');
    expect(gate).not.toContain('clearCoveredHold(');
  });

  it('no admission or terminal-path open consults the hold, and every one is overdraft-tolerant', () => {
    const opens = [JOIN_MEETING, OPEN_ON_BEHALF, SETTLE_SESSIONLESS];
    for (const target of opens) {
      const code = scan(target);
      // Positive control — the file exists and is non-trivial.
      expect(code.length, target.displayPath).toBeGreaterThan(0);
      expect(code, target.displayPath).not.toContain('hasOpenReceivable(');
      expect(code, target.displayPath).not.toContain('readHoldStatus(');
      expect(code, target.displayPath).not.toContain('readSnapshot(');
    }
    // The two files that call the open themselves pass the tolerant policy, literally.
    expect(scan(JOIN_MEETING)).toContain("fundingPolicy: 'overdraft_tolerant'");
    expect(scan(OPEN_ON_BEHALF)).toContain("fundingPolicy: 'overdraft_tolerant'");
    // Positive controls — the functions the scans above are about are present in these files.
    expect(scan(JOIN_MEETING)).toContain('openCaseSessionBestEffort');
    expect(scan(OPEN_ON_BEHALF)).toContain('openSessionOnBehalfOfBooker');
    expect(scan(SETTLE_SESSIONLESS)).toContain('settleSessionlessCaseMeeting');
  });
});
