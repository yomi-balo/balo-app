import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { assessCaseBookingFunding } from '@balo/shared/credit';
import { db } from '../client';
import { expertProfiles } from '../schema';
import {
  caseEngagementFactory,
  creditWalletFactory,
  expertFactory,
  meetingFactory,
  userFactory,
} from '../test/factories';
import { bookingFundingRepository } from '../repositories/booking-funding';
import { creditLedgerRepository } from '../repositories/credit-ledger';
import { creditSessionsRepository } from '../repositories/credit-sessions';

/**
 * ⚠⚠ INVARIANT (integration) — A NO-MANDATE CASE BOOKING IS ACCEPTED ONLY WHEN ITS CREDIT COVERS
 * IT AT CHECK TIME, READ FROM A REAL COMPANY. ADR-1040 Amendment 7 §H (BAL-474, D6.5 / D8.5).
 *
 * The pure verdict is pinned by the sibling unit suite; this proves the ONE snapshot
 * (`bookingFundingRepository.readSnapshot`) feeds it the right `available` and the right
 * reservable bookings: an upcoming sessionless Case booking reserves its estimate; once it opens
 * a session it leaves the reservable set (its hold is inside `available` instead — never counted
 * twice); a live call's posted minutes are subtracted ONCE (D8.5); and the reservation is priced
 * at the expert's CURRENT rate (§I.4).
 *
 * Per ADR-1032 this was AUTHORED AND RUN RED before the snapshot, the reservable finder and the
 * verdict existed. On main the booking gate compared only `available (30,000) ≥ estimate
 * (21,000)` and accepted booking B.
 */

const MINUTE_MS = 60_000;
/** Client 700 / minute at the DEFAULT fee (`deriveSessionEstimate`: 33,600 → 42,000 / h). */
const EXPERT_HOURLY_700 = 33_600;
/** Client 125 / minute at the default fee — a cheap second expert for the rate-rise case. */
const EXPERT_HOURLY_125 = 6_000;

interface Company {
  companyId: string;
  walletId: string;
  memberId: string;
}

async function noMandateCompany(balanceMinor: number): Promise<Company> {
  const { wallet, companyId } = await creditWalletFactory({ values: { balanceMinor } });
  const member = await userFactory();
  return { companyId, walletId: wallet.id, memberId: member.id };
}

async function expertAt(rateCents: number): Promise<string> {
  const expert = await expertFactory();
  await db.update(expertProfiles).set({ rateCents }).where(eq(expertProfiles.id, expert.id));
  return expert.id;
}

/** A minute-aligned window `startOffsetMinutes` from now — never a hardcoded calendar date. */
function window(startOffsetMinutes: number, minutes: number): { start: Date; end: Date } {
  const base = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;
  const start = new Date(base + startOffsetMinutes * MINUTE_MS);
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
}

/** A booked, upcoming, sessionless Case meeting for `company` with `expertProfileId`. */
async function bookCase(
  company: Company,
  expertProfileId: string,
  startOffsetMinutes: number,
  minutes: number
): Promise<{ meetingId: string; engagementId: string }> {
  const { engagement } = await caseEngagementFactory({
    companyId: company.companyId,
    expertProfileId,
  });
  const { start, end } = window(startOffsetMinutes, minutes);
  const { meeting } = await meetingFactory({
    contexts: [{ contextType: 'case', contextId: engagement.id }],
    values: { status: 'scheduled', scheduledStart: start, scheduledEnd: end },
  });
  return { meetingId: meeting.id, engagementId: engagement.id };
}

async function checkBooking(
  company: Company,
  expertProfileId: string,
  booking: { start: Date; end: Date }
): Promise<ReturnType<typeof assessCaseBookingFunding>> {
  const snapshot = await bookingFundingRepository.readSnapshot({
    companyId: company.companyId,
    expertProfileId,
    now: new Date(),
  });
  return assessCaseBookingFunding(snapshot, {
    scheduledStart: booking.start,
    scheduledEnd: booking.end,
  });
}

describe('INVARIANT (integration): a no-mandate booking is accepted only within its credit at check time', () => {
  it('an upcoming booking reserves its estimate; opening its session moves the hold into available — never counted twice; a live call is subtracted once', async () => {
    const company = await noMandateCompany(30_000);
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);

    // A — a 30-minute Case consultation at 700 / minute ⇒ estimate 21,000, booked and upcoming.
    const a = await bookCase(company, expertProfileId, 120, 30);

    // B — the same estimate. 30,000 − 21,000 reserved < 21,000 ⇒ refused BECAUSE of A.
    const b = window(240, 30);
    const refused = await checkBooking(company, expertProfileId, b);
    expect(refused).toMatchObject({
      ok: false,
      reason: 'reserved_by_upcoming',
      estimateMinor: 21_000,
      availableMinor: 30_000,
      reservedMinor: 21_000,
      reservedBookingCount: 1,
      topUpNeededMinor: 12_000,
    });

    // Top up exactly the figure ⇒ B is accepted.
    await creditLedgerRepository.postEntry({
      walletId: company.walletId,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 12_000,
      idempotencyKey: `manual_purchase:${company.walletId}:reservation-topup`,
      memberId: company.memberId,
    });
    expect(await checkBooking(company, expertProfileId, b)).toEqual({ ok: true, arm: 'balance' });

    // A's admission opens its session (hold 21,000). A leaves the reservable set and its hold is
    // inside `available` instead: 42,000 − 21,000 = 21,000, reserved 0 ⇒ B still accepted.
    const opened = await creditSessionsRepository.open({
      walletId: company.walletId,
      companyId: company.companyId,
      expertProfileId,
      initiatingMemberId: company.memberId,
      estimatedMinutes: 30,
      meetingId: a.meetingId,
      engagementId: a.engagementId,
      durationSource: 'presence',
    });
    if (!opened.ok) throw new Error(`expected open ok, got ${opened.code}`);
    const afterOpen = await bookingFundingRepository.readSnapshot({
      companyId: company.companyId,
      expertProfileId,
      now: new Date(),
    });
    expect(afterOpen).toMatchObject({ kind: 'no_mandate', availableMinor: 21_000, reservable: [] });
    expect(await checkBooking(company, expertProfileId, b)).toEqual({ ok: true, arm: 'balance' });

    // A goes live and posts 10 ticks (7,000): balance 35,000, A's hold netted to 14,000 ⇒
    // available is STILL 21,000 — a live call's drawn minutes are subtracted once, not twice.
    const connectedAt = new Date(Date.now() - 11 * MINUTE_MS);
    await creditSessionsRepository.connectWithTransition(opened.session.id, { now: connectedAt });
    const metered = await creditSessionsRepository.meterSessionToNow(
      opened.session.id,
      new Date(connectedAt.getTime() + 10 * MINUTE_MS + 30_000),
      { floorMinutes: 15 }
    );
    expect(metered.ticksPosted).toBe(10);
    const live = await bookingFundingRepository.readSnapshot({
      companyId: company.companyId,
      expertProfileId,
      now: new Date(),
    });
    expect(live).toMatchObject({ kind: 'no_mandate', availableMinor: 21_000, reservable: [] });
    expect(await checkBooking(company, expertProfileId, b)).toEqual({ ok: true, arm: 'balance' });
  });

  it("a rate rise raises an upcoming booking's reservation on the next check (§I.4)", async () => {
    const company = await noMandateCompany(30_000);
    const expensiveExpert = await expertAt(EXPERT_HOURLY_700);
    const cheapExpert = await expertAt(EXPERT_HOURLY_125);

    await bookCase(company, expensiveExpert, 120, 30); // reserves 21,000 at today's rate
    const b = window(240, 30); // 30 × 125 = 3,750 with the cheap expert
    expect(await checkBooking(company, cheapExpert, b)).toEqual({ ok: true, arm: 'balance' });

    // The expensive expert doubles their rate ⇒ the upcoming booking now reserves 42,000.
    await db
      .update(expertProfiles)
      .set({ rateCents: EXPERT_HOURLY_700 * 2 })
      .where(eq(expertProfiles.id, expensiveExpert));
    expect(await checkBooking(company, cheapExpert, b)).toMatchObject({
      ok: false,
      reason: 'reserved_by_upcoming',
      estimateMinor: 3_750,
      availableMinor: 30_000,
      reservedMinor: 42_000,
      reservedBookingCount: 1,
      topUpNeededMinor: 15_750,
    });
  });
});
