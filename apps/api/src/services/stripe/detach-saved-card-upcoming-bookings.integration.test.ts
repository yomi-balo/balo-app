import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 owner ruling D10.6 — THE CARD CANNOT LEAVE WHILE IT IS BACKING UNCOVERED BOOKINGS
 * (ADR-1040 Amendment 7 §H), end to end against a real Postgres.
 *
 * D6.5 exempts a company with an active mandate from the booking balance arm and the soft
 * reservation ("the card funds anything above the credit"). Pulling the card would make that
 * false for every consultation already booked, so `detachSavedCard` refuses — before any Stripe
 * call — while `available (netted) − Σ upcoming reservable Case bookings' estimates < 0`,
 * carrying `topUpNeededMinor` and `reservedBookingCount`.
 *
 * What only a real database can carry here: the snapshot read (the NETTED balance and the
 * reservable-bookings finder, on one repeatable-read executor), the wallet row the refusal must
 * leave untouched, and the removal that must still go through when the bookings are covered.
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`,
 * inside the harness's one rolled-back transaction per test (`setup-integration.ts`). Seeding
 * goes through production repositories and `seedBookingParties`.
 *
 * Mocks, and only these: the Stripe client (`paymentMethods.detach` — the one outbound call, so
 * "never touched on a refusal" is assertable) and the BullMQ queue (the post-commit
 * `credit.saved_card.detached` notice). Every instant is derived from `new Date()`.
 */

const { queued, mockGetQueue, mockDetach } = vi.hoisted(() => {
  const jobs: { queue: string; name: string; data: unknown }[] = [];
  return {
    queued: jobs,
    mockGetQueue: vi.fn((queue: string) => ({
      add: vi.fn(async (name: string, data: unknown) => {
        jobs.push({ queue, name, data });
        return { id: `job-${String(jobs.length)}` };
      }),
    })),
    mockDetach: vi.fn(),
  };
});

vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('../../lib/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/stripe.js')>()),
  getStripeClient: () => ({ paymentMethods: { detach: mockDetach, retrieve: vi.fn() } }),
}));

import {
  creditWallets,
  creditWalletsRepository,
  db,
  eq,
  expertProfiles,
  expertsRepository,
  meetingPresenceRepository,
  meetings,
  meetingsRepository,
} from '@balo/db';
import { seedBookingParties } from '../../test/fixtures/booking-graph.js';
import { detachSavedCard } from './mandate.js';

const MINUTE_MS = 60_000;
/** Client 700 / minute at the default fee — a 30-minute booking reserves 21,000. */
const EXPERT_HOURLY = 33_600;
const ONE_BOOKING_MINOR = 21_000;

interface Ctx {
  readonly companyId: string;
  readonly memberId: string;
  readonly expertProfileId: string;
  readonly engagementId: string;
  readonly walletId: string;
}

async function seedWallet(opts: { balanceMinor: number; mandate: boolean }): Promise<Ctx> {
  const parties = await seedBookingParties();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY })
    .where(eq(expertProfiles.id, parties.expertProfileId));
  const [wallet] = await db
    .insert(creditWallets)
    .values({
      companyId: parties.companyId,
      balanceMinor: opts.balanceMinor,
      lowBalanceMode: 'notify_only',
      // A saved card is on file either way; only an ACTIVE mandate exempts the company (D6.5).
      mandateStatus: opts.mandate ? 'active' : null,
      stripeCustomerId: 'cus_bal474_d106',
      stripePaymentMethodId: 'pm_bal474_d106',
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 12,
      cardExpYear: 2099,
    })
    .returning({ id: creditWallets.id });
  if (wallet === undefined) {
    throw new Error('fixture: wallet insert returned no row');
  }
  return {
    companyId: parties.companyId,
    memberId: parties.memberUserId,
    expertProfileId: parties.expertProfileId,
    engagementId: parties.caseEngagementId,
    walletId: wallet.id,
  };
}

/** An UPCOMING 30-minute `case` meeting on the fixture's engagement — sessionless, so reservable. */
async function bookUpcoming(ctx: Ctx, startOffsetMinutes: number): Promise<void> {
  const start = new Date(Date.now() + startOffsetMinutes * MINUTE_MS);
  await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 30 * MINUTE_MS),
    contexts: [{ contextType: 'case', contextId: ctx.engagementId }],
    actorUserId: ctx.memberId,
  });
}

async function walletRow(walletId: string) {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error('wallet vanished');
  }
  return wallet;
}

beforeEach(() => {
  queued.length = 0;
  mockDetach.mockReset();
  mockDetach.mockResolvedValue({ id: 'pm_bal474_d106', customer: null });
});

describe('detachSavedCard — the card is backing uncovered upcoming bookings (D10.6)', () => {
  it('⚠ uncovered ⇒ refused with the code and the figures, and the card is STILL attached', async () => {
    const ctx = await seedWallet({ balanceMinor: 10_000, mandate: true });
    await bookUpcoming(ctx, 60);
    await bookUpcoming(ctx, 180);

    const result = await detachSavedCard(ctx.walletId, ctx.memberId);

    expect(result).toEqual({
      status: 'upcoming_bookings_uncovered',
      // 2 × 21,000 reserved − 10,000 available.
      topUpNeededMinor: 2 * ONE_BOOKING_MINOR - 10_000,
      reservedBookingCount: 2,
    });
    expect(mockDetach).not.toHaveBeenCalled();
    expect(queued).toEqual([]);
    const wallet = await walletRow(ctx.walletId);
    expect(wallet.stripePaymentMethodId).toBe('pm_bal474_d106');
    expect(wallet.mandateStatus).toBe('active');
    expect(wallet.cardLast4).toBe('4242');
  });

  it('covered ⇒ the removal proceeds: detached at Stripe and cleared locally', async () => {
    const ctx = await seedWallet({ balanceMinor: 2 * ONE_BOOKING_MINOR, mandate: true });
    await bookUpcoming(ctx, 60);
    await bookUpcoming(ctx, 180);

    const result = await detachSavedCard(ctx.walletId, ctx.memberId);

    expect(result).toMatchObject({ status: 'removed' });
    expect(mockDetach).toHaveBeenCalledWith('pm_bal474_d106');
    expect((await walletRow(ctx.walletId)).stripePaymentMethodId).toBeNull();
  });

  it('no upcoming bookings ⇒ the removal proceeds, however low the balance', async () => {
    const ctx = await seedWallet({ balanceMinor: 0, mandate: true });

    const result = await detachSavedCard(ctx.walletId, ctx.memberId);

    expect(result).toMatchObject({ status: 'removed' });
    expect(mockDetach).toHaveBeenCalledTimes(1);
    expect((await walletRow(ctx.walletId)).stripePaymentMethodId).toBeNull();
  });

  it('boundary: available === reserved proceeds; one minor unit short is refused', async () => {
    const short = await seedWallet({ balanceMinor: ONE_BOOKING_MINOR - 1, mandate: true });
    await bookUpcoming(short, 60);
    expect(await detachSavedCard(short.walletId, short.memberId)).toEqual({
      status: 'upcoming_bookings_uncovered',
      topUpNeededMinor: 1,
      reservedBookingCount: 1,
    });
    expect(mockDetach).not.toHaveBeenCalled();

    const exact = await seedWallet({ balanceMinor: ONE_BOOKING_MINOR, mandate: true });
    await bookUpcoming(exact, 60);
    expect(await detachSavedCard(exact.walletId, exact.memberId)).toMatchObject({
      status: 'removed',
    });
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });

  it('a top-up of exactly topUpNeededMinor lets the same card go — the "or more" copy is literally true', async () => {
    const ctx = await seedWallet({ balanceMinor: 10_000, mandate: true });
    await bookUpcoming(ctx, 60);
    const refused = await detachSavedCard(ctx.walletId, ctx.memberId);
    if (refused.status !== 'upcoming_bookings_uncovered') {
      throw new Error(`expected a refusal, got ${refused.status}`);
    }

    await db
      .update(creditWallets)
      .set({ balanceMinor: 10_000 + refused.topUpNeededMinor })
      .where(eq(creditWallets.id, ctx.walletId));

    expect(await detachSavedCard(ctx.walletId, ctx.memberId)).toMatchObject({ status: 'removed' });
  });

  it('no active mandate ⇒ nothing to protect: existing behaviour, the removal proceeds', async () => {
    const ctx = await seedWallet({ balanceMinor: 0, mandate: false });
    await bookUpcoming(ctx, 60);

    const result = await detachSavedCard(ctx.walletId, ctx.memberId);

    expect(result).toMatchObject({ status: 'removed' });
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });

  it('another company’s bookings are never counted against this wallet', async () => {
    const mine = await seedWallet({ balanceMinor: 0, mandate: true });
    const other = await seedWallet({ balanceMinor: 0, mandate: true });
    await bookUpcoming(other, 60);

    expect(await detachSavedCard(mine.walletId, mine.memberId)).toMatchObject({
      status: 'removed',
    });
  });
});

describe('detachSavedCard — a LIVE Case call that has no session yet (BAL-474 D11.1, Rule A)', () => {
  /**
   * Under Rule A an early call has no session until billing starts at the scheduled start, so the card
   * is the only thing standing behind it. A Case meeting of the company that is `in_progress` — or
   * `waiting_for_participants` with a client-side row open — and has no non-cancelled session blocks
   * the removal with the EXISTING `settlement_outstanding` refusal.
   */
  async function bookLive(
    ctx: Ctx,
    live: {
      readonly status: 'in_progress' | 'waiting_for_participants';
      readonly presence: ReadonlyArray<'expert' | 'client'>;
    }
  ): Promise<string> {
    const start = new Date(Date.now() - 20 * MINUTE_MS);
    const { meeting } = await meetingsRepository.create({
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * MINUTE_MS),
      contexts: [{ contextType: 'case', contextId: ctx.engagementId }],
      actorUserId: ctx.memberId,
    });
    await db.update(meetings).set({ status: live.status }).where(eq(meetings.id, meeting.id));
    const expert = await expertsRepository.findUserIdByProfileId(ctx.expertProfileId);
    if (expert === undefined) {
      throw new Error('fixture: the expert profile resolves no user');
    }
    for (const party of live.presence) {
      await meetingPresenceRepository.open({
        meetingId: meeting.id,
        userId: party === 'expert' ? expert.user.id : ctx.memberId,
        meetingGuestId: null,
        party,
        joinedAt: new Date(start.getTime() - 10 * MINUTE_MS),
      });
    }
    return meeting.id;
  }

  it('⚠ an in_progress Case call with presence and NO session ⇒ settlement_outstanding, the card stays attached, Stripe untouched', async () => {
    // Fully covered credit: the D10.6 booking check cannot be what refuses this.
    const ctx = await seedWallet({ balanceMinor: 1_000_000, mandate: true });
    await bookLive(ctx, { status: 'in_progress', presence: ['expert', 'client'] });

    expect(await detachSavedCard(ctx.walletId, ctx.memberId)).toEqual({
      status: 'settlement_outstanding',
    });
    expect(mockDetach).not.toHaveBeenCalled();
    expect((await walletRow(ctx.walletId)).stripePaymentMethodId).toBe('pm_bal474_d106');
  });

  it('⚠ a waiting_for_participants Case call with a client-side row open and no session ⇒ settlement_outstanding', async () => {
    const ctx = await seedWallet({ balanceMinor: 1_000_000, mandate: true });
    await bookLive(ctx, { status: 'waiting_for_participants', presence: ['client'] });

    expect(await detachSavedCard(ctx.walletId, ctx.memberId)).toEqual({
      status: 'settlement_outstanding',
    });
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it('control — a waiting room with only the EXPERT in it (no client-side row) does not block the removal', async () => {
    const ctx = await seedWallet({ balanceMinor: 1_000_000, mandate: true });
    await bookLive(ctx, { status: 'waiting_for_participants', presence: ['expert'] });

    expect(await detachSavedCard(ctx.walletId, ctx.memberId)).toMatchObject({ status: 'removed' });
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });

  it('control — a wallet with no live call at all is unaffected', async () => {
    const ctx = await seedWallet({ balanceMinor: 1_000_000, mandate: true });

    expect(await detachSavedCard(ctx.walletId, ctx.memberId)).toMatchObject({ status: 'removed' });
  });

  it('control — another company’s live call never blocks this wallet', async () => {
    const mine = await seedWallet({ balanceMinor: 1_000_000, mandate: true });
    const other = await seedWallet({ balanceMinor: 1_000_000, mandate: true });
    await bookLive(other, { status: 'in_progress', presence: ['expert', 'client'] });

    expect(await detachSavedCard(mine.walletId, mine.memberId)).toMatchObject({
      status: 'removed',
    });
  });
});
