import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { expertProfiles, type NewCreditWallet } from '../schema';
import {
  caseEngagementFactory,
  creditWalletFactory,
  expertFactory,
  meetingFactory,
  userFactory,
} from '../test/factories';
import { bookingFundingRepository } from './booking-funding';
import { creditLedgerRepository } from './credit-ledger';
import { creditReceivablesRepository } from './credit-receivables';
import { creditSessionsRepository } from './credit-sessions';

/**
 * Integration tests for `bookingFundingRepository` (BAL-474, plan §I.2 / §I.7) — the ONE snapshot
 * both Case booking funding checks read. Covers every snapshot kind, the reservable set as the
 * snapshot reports it (upcoming, not-yet-started, sessionless Case bookings of THIS company, at
 * the expert's CURRENT rate), and `availableMinor` netting a live session's hold by its posted
 * consumption (D8.5).
 *
 * The finder's full inclusion/exclusion table is `meetings.integration.test.ts`
 * (`listReservableCaseBookings`); the netted sum's edge cases are
 * `credit-holds.integration.test.ts` (`getAvailableForBooking`). The ISOLATION of the snapshot
 * cannot be observed under this single-connection harness — see `booking-funding.test.ts` and
 * `booking-funding.concurrency.integration.test.ts`.
 */

const MINUTE_MS = 60_000;
/** Client 700 / minute at the default fee. */
const EXPERT_HOURLY_700 = 33_600;

interface Company {
  companyId: string;
  walletId: string;
  memberId: string;
}

async function company(values: Partial<NewCreditWallet>): Promise<Company> {
  const { wallet, companyId } = await creditWalletFactory({ values });
  const member = await userFactory();
  return { companyId, walletId: wallet.id, memberId: member.id };
}

async function expertAt(rateCents: number | null): Promise<string> {
  const expert = await expertFactory();
  await db.update(expertProfiles).set({ rateCents }).where(eq(expertProfiles.id, expert.id));
  return expert.id;
}

function window(startOffsetMinutes: number, minutes: number): { start: Date; end: Date } {
  const base = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;
  const start = new Date(base + startOffsetMinutes * MINUTE_MS);
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
}

async function bookCase(
  owner: Company,
  expertProfileId: string,
  startOffsetMinutes: number,
  minutes: number
): Promise<{ meetingId: string; engagementId: string }> {
  const { engagement } = await caseEngagementFactory({
    companyId: owner.companyId,
    expertProfileId,
  });
  const { start, end } = window(startOffsetMinutes, minutes);
  const { meeting } = await meetingFactory({
    contexts: [{ contextType: 'case', contextId: engagement.id }],
    values: { status: 'scheduled', scheduledStart: start, scheduledEnd: end },
  });
  return { meetingId: meeting.id, engagementId: engagement.id };
}

function snapshotFor(owner: Company | { companyId: string }, expertProfileId: string) {
  return bookingFundingRepository.readSnapshot({
    companyId: owner.companyId,
    expertProfileId,
    now: new Date(),
  });
}

describe('bookingFundingRepository.readSnapshot — each kind', () => {
  it('no_wallet — a company that has never had a wallet', async () => {
    const booker = await company({});
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    // A company id with no wallet row (the factory's company carries one; use a fresh company).
    const { companyId } = await caseEngagementFactory({ expertProfileId });
    expect(await snapshotFor({ companyId }, expertProfileId)).toEqual({ kind: 'no_wallet' });
    // …and a company WITH a wallet does not read as no_wallet.
    expect((await snapshotFor(booker, expertProfileId)).kind).not.toBe('no_wallet');
  });

  it('on_hold — an open receivable, carrying the hold status (read BEFORE the mandate)', async () => {
    const booker = await company({
      balanceMinor: 0,
      mandateStatus: 'active',
      stripeCustomerId: 'cus_snapshot',
      stripePaymentMethodId: 'pm_snapshot',
    });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const opened = await creditSessionsRepository.open({
      walletId: booker.walletId,
      companyId: booker.companyId,
      expertProfileId,
      initiatingMemberId: booker.memberId,
      estimatedMinutes: 10,
    });
    if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
    await creditSessionsRepository.cancel(opened.session.id);
    await creditLedgerRepository.postEntry({
      walletId: booker.walletId,
      entryType: 'consume',
      reason: 'session_consume',
      amountMinor: -5_000,
      idempotencyKey: `session_consume:${opened.session.id}:snapshot`,
      memberId: booker.memberId,
      sessionId: opened.session.id,
    });
    await creditReceivablesRepository.open({
      companyId: booker.companyId,
      walletId: booker.walletId,
      sessionId: opened.session.id,
      amountMinor: 5_000,
      reason: 'settlement_declined',
    });

    const snapshot = await snapshotFor(booker, expertProfileId);
    expect(snapshot).toMatchObject({
      kind: 'on_hold',
      walletId: booker.walletId,
      hold: {
        onHold: true,
        openReceivableCount: 1,
        balanceMinor: -5_000,
        amountToClearMinor: 5_000,
      },
    });
  });

  it('mandate — an active mandate and no hold short-circuits', async () => {
    const booker = await company({
      balanceMinor: 0,
      mandateStatus: 'active',
      stripeCustomerId: 'cus_snapshot',
      stripePaymentMethodId: 'pm_snapshot',
    });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    expect(await snapshotFor(booker, expertProfileId)).toEqual({
      kind: 'mandate',
      walletId: booker.walletId,
    });
  });

  it('unknown_expert — the booked expert profile does not exist', async () => {
    const booker = await company({ balanceMinor: 10_000 });
    expect(await snapshotFor(booker, '00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'unknown_expert',
      walletId: booker.walletId,
    });
  });

  it('no_mandate — the booked expert’s rate (null when unset), available, and the reservable set', async () => {
    const booker = await company({ balanceMinor: 30_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const rateless = await expertAt(null);
    const a = await bookCase(booker, expertProfileId, 120, 30);

    const snapshot = await snapshotFor(booker, expertProfileId);
    expect(snapshot).toMatchObject({
      kind: 'no_mandate',
      walletId: booker.walletId,
      expertRateCents: EXPERT_HOURLY_700,
      availableMinor: 30_000,
    });
    if (snapshot.kind !== 'no_mandate') throw new Error('expected no_mandate');
    expect(snapshot.reservable).toHaveLength(1);
    expect(snapshot.reservable[0]).toMatchObject({
      meetingId: a.meetingId,
      expertProfileId,
      expertRateCents: EXPERT_HOURLY_700,
    });

    expect(await snapshotFor(booker, rateless)).toMatchObject({
      kind: 'no_mandate',
      expertRateCents: null,
    });
  });
});

describe('bookingFundingRepository.readSnapshot — the reservable set and available', () => {
  it('another company’s booking is never reserved against this one', async () => {
    const booker = await company({ balanceMinor: 30_000 });
    const other = await company({ balanceMinor: 30_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    await bookCase(other, expertProfileId, 120, 30);
    const snapshot = await snapshotFor(booker, expertProfileId);
    expect(snapshot).toMatchObject({ kind: 'no_mandate', reservable: [] });
  });

  it('a meeting whose only session was cancelled is reserved again — it reads as sessionless', async () => {
    const booker = await company({ balanceMinor: 30_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const a = await bookCase(booker, expertProfileId, 120, 30);
    const opened = await creditSessionsRepository.open({
      walletId: booker.walletId,
      companyId: booker.companyId,
      expertProfileId,
      initiatingMemberId: booker.memberId,
      estimatedMinutes: 30,
      meetingId: a.meetingId,
      engagementId: a.engagementId,
      durationSource: 'presence',
    });
    if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
    // While the session is pending, the meeting's hold is inside `available` — not reserved.
    expect(await snapshotFor(booker, expertProfileId)).toMatchObject({
      availableMinor: 30_000 - 21_000,
      reservable: [],
    });

    await creditSessionsRepository.cancel(opened.session.id);
    const snapshot = await snapshotFor(booker, expertProfileId);
    expect(snapshot).toMatchObject({ availableMinor: 30_000 });
    if (snapshot.kind !== 'no_mandate') throw new Error('expected no_mandate');
    expect(snapshot.reservable.map((row) => row.meetingId)).toEqual([a.meetingId]);
  });

  it('reserves at the expert’s CURRENT rate — a rate change since booking is reflected', async () => {
    const booker = await company({ balanceMinor: 30_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    await bookCase(booker, expertProfileId, 120, 30);
    await db
      .update(expertProfiles)
      .set({ rateCents: EXPERT_HOURLY_700 * 2 })
      .where(eq(expertProfiles.id, expertProfileId));
    const snapshot = await snapshotFor(booker, expertProfileId);
    if (snapshot.kind !== 'no_mandate') throw new Error('expected no_mandate');
    expect(snapshot.reservable[0]?.expertRateCents).toBe(EXPERT_HOURLY_700 * 2);
  });

  it('⚠ D8.5 — available nets a live session’s hold by its posted consumption (29,000, not 15,000)', async () => {
    // The plan's worked example: balance 50,000; a live 30-minute session at 700 / min holds
    // 21,000; at minute 20 the balance is 36,000. Gross available would be 15,000 — subtracting
    // the 14,000 already drawn TWICE. Netted: 36,000 − (21,000 − 14,000) = 29,000.
    const booker = await company({ balanceMinor: 50_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const live = await bookCase(booker, expertProfileId, -30, 30);
    const opened = await creditSessionsRepository.open({
      walletId: booker.walletId,
      companyId: booker.companyId,
      expertProfileId,
      initiatingMemberId: booker.memberId,
      estimatedMinutes: 30,
      meetingId: live.meetingId,
      engagementId: live.engagementId,
      durationSource: 'presence',
    });
    if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
    const connectedAt = new Date(Date.now() - 25 * MINUTE_MS);
    await creditSessionsRepository.connectWithTransition(opened.session.id, { now: connectedAt });
    await creditSessionsRepository.meterSessionToNow(
      opened.session.id,
      new Date(connectedAt.getTime() + 20 * MINUTE_MS + 30_000),
      { floorMinutes: 15 }
    );

    expect(await snapshotFor(booker, expertProfileId)).toMatchObject({
      kind: 'no_mandate',
      availableMinor: 29_000,
    });
  });
});

describe('bookingFundingRepository.readCardRemovalSnapshot (owner ruling D10.6)', () => {
  const MANDATE = {
    mandateStatus: 'active',
    stripeCustomerId: 'cus_removal',
    stripePaymentMethodId: 'pm_removal',
  } as const;

  function removalSnapshotFor(owner: { companyId: string }) {
    return bookingFundingRepository.readCardRemovalSnapshot({
      companyId: owner.companyId,
      now: new Date(),
    });
  }

  it('no_wallet — a company that has never had a wallet', async () => {
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const { companyId } = await caseEngagementFactory({ expertProfileId });
    expect(await removalSnapshotFor({ companyId })).toEqual({ kind: 'no_wallet' });
  });

  it('no_mandate — a wallet without an active mandate', async () => {
    const booker = await company({ balanceMinor: 30_000 });
    expect(await removalSnapshotFor(booker)).toEqual({
      kind: 'no_mandate',
      walletId: booker.walletId,
    });
  });

  it('mandate — carries the NETTED available balance and the upcoming reservable bookings, which the booking snapshot never reads', async () => {
    const booker = await company({ balanceMinor: 30_000, ...MANDATE });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    const a = await bookCase(booker, expertProfileId, 120, 30);

    const snapshot = await removalSnapshotFor(booker);
    expect(snapshot).toMatchObject({
      kind: 'mandate',
      walletId: booker.walletId,
      availableMinor: 30_000,
    });
    if (snapshot.kind !== 'mandate') throw new Error('expected mandate');
    expect(snapshot.reservable.map((row) => row.meetingId)).toEqual([a.meetingId]);
    expect(snapshot.reservable[0]).toMatchObject({ expertRateCents: EXPERT_HOURLY_700 });

    // The booking snapshot for the same company still short-circuits at the mandate.
    expect(await snapshotFor(booker, expertProfileId)).toEqual({
      kind: 'mandate',
      walletId: booker.walletId,
    });
  });

  it('another company’s booking is never counted against this wallet', async () => {
    const booker = await company({ balanceMinor: 30_000, ...MANDATE });
    const other = await company({ balanceMinor: 30_000 });
    const expertProfileId = await expertAt(EXPERT_HOURLY_700);
    await bookCase(other, expertProfileId, 120, 30);
    expect(await removalSnapshotFor(booker)).toMatchObject({ kind: 'mandate', reservable: [] });
  });
});
