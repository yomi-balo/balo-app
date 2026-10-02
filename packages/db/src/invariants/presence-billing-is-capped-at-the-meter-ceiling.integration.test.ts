import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';
import { db } from '../client';
import {
  auditEvents,
  creditLedger,
  creditSessions,
  expertProfiles,
  type NewCreditWallet,
} from '../schema';
import { creditWalletFactory, expertFactory, meetingFactory, userFactory } from '../test/factories';
import { creditWalletsRepository } from '../repositories/credit-wallets';
import {
  creditSessionsRepository,
  SettlementRefusedError,
  type SettleFromPresenceRepoInput,
} from '../repositories/credit-sessions';

/**
 * ⚠⚠ INVARIANT (integration) — NO SESSION'S NEW DRAW OR BILL EXCEEDS MAX_SESSION_MINUTES; MINUTES
 * ALREADY DRAWN ARE ALWAYS BILLABLE. ADR-1040 Amendment 7 §C step 6 / §K (BAL-585).
 *
 * The source-scanned and pure claims live in the sibling unit suite. This proves them on real
 * rows:
 *
 *   · a presence session connected 300 minutes ago posts exactly 240 ticks, then none (a);
 *   · a live_capture backfill past the ceiling clamps at 240, then posts none (b);
 *   · settlement refuses a billable figure above max(240, drawn) and a top-up past the billed
 *     figure with the typed error, and writes NOTHING (c, d);
 *   · a legacy session already drawn to 4,233 settles in full with no new tick (e).
 */

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const FLOOR = 15;
const EXPERT_HOURLY = 30_000;

interface Ctx {
  walletId: string;
  companyId: string;
  expertProfileId: string;
  memberId: string;
}

async function setup(): Promise<Ctx> {
  const values: Partial<NewCreditWallet> = { balanceMinor: 5_000_000 };
  const { wallet, companyId } = await creditWalletFactory({ values });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY })
    .where(eq(expertProfiles.id, expert.id));
  return { walletId: wallet.id, companyId, expertProfileId: expert.id, memberId: member.id };
}

async function endedMeetingId(): Promise<string> {
  const { meeting } = await meetingFactory({
    values: { status: 'ended', endedAt: new Date(Date.now() - 2 * HOUR_MS) },
  });
  return meeting.id;
}

async function openSession(ctx: Ctx, durationSource: 'presence' | 'live_capture'): Promise<string> {
  const res = await creditSessionsRepository.open({
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes: 30,
    ...(durationSource === 'presence' ? { meetingId: await endedMeetingId(), durationSource } : {}),
  });
  if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);
  return res.session.id;
}

async function meterNow(
  id: string,
  now: Date
): Promise<{ ticksPosted: number; lastTickSeq: number }> {
  const res = await creditSessionsRepository.meterSessionToNow(id, now, {
    floorMinutes: FLOOR,
  });
  return { ticksPosted: res.ticksPosted, lastTickSeq: res.session.lastTickSeq };
}

async function consumeCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.sessionId, sessionId), eq(creditLedger.reason, 'session_consume')));
  return rows.length;
}

/** Every row a settlement could write for this session: the wallet's ledger and the session's audit trail. */
async function writeFootprint(
  walletId: string,
  sessionId: string
): Promise<{ ledgerRows: number; auditRows: number }> {
  const ledger = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.walletId, walletId));
  const audits = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, sessionId));
  return { ledgerRows: ledger.length, auditRows: audits.length };
}

async function walletBalance(walletId: string): Promise<number> {
  return (await creditWalletsRepository.findById(walletId))?.balanceMinor ?? Number.NaN;
}

function figures(
  sessionId: string,
  meetingId: string,
  overrides: Partial<SettleFromPresenceRepoInput>
): SettleFromPresenceRepoInput {
  return {
    sessionId,
    meetingId,
    billableMinutes: FLOOR,
    actualMinutes: FLOOR,
    billingFloorMinutes: FLOOR,
    topUpFromTickSeq: 1,
    topUpToTickSeq: FLOOR,
    minutesAlreadyDrawn: 0,
    shape: 'held',
    floorApplied: false,
    outcome: 'completed',
    actorUserId: null,
    now: new Date(Date.now() - HOUR_MS),
    ...overrides,
  };
}

async function meetingIdOf(sessionId: string): Promise<string> {
  const session = await creditSessionsRepository.findById(sessionId);
  if (session?.meetingId == null) throw new Error('session has no meeting');
  return session.meetingId;
}

describe('presence billing is capped at the meter ceiling — real rows (BAL-585)', () => {
  it('(a) a presence session connected 300 minutes ago posts exactly 240 ticks, then none', async () => {
    const ctx = await setup();
    const id = await openSession(ctx, 'presence');
    const connectedAt = new Date(Date.now() - 300 * MINUTE_MS - 30_000);
    await creditSessionsRepository.connectWithTransition(id, { now: connectedAt });

    const first = await meterNow(id, new Date());
    expect(first.ticksPosted).toBe(MAX_SESSION_MINUTES);
    expect(first.lastTickSeq).toBe(MAX_SESSION_MINUTES);
    expect(await consumeCount(id)).toBe(MAX_SESSION_MINUTES);

    const second = await meterNow(id, new Date(Date.now() + MINUTE_MS));
    expect(second.ticksPosted).toBe(0);
    expect(await consumeCount(id)).toBe(MAX_SESSION_MINUTES);
  });

  it('(b) a live_capture backfill past the ceiling clamps at 240, then posts none', async () => {
    const ctx = await setup();
    const id = await openSession(ctx, 'live_capture');
    const connectedAt = new Date(Date.now() - 300 * MINUTE_MS - 30_000);
    await creditSessionsRepository.connectWithTransition(id, { now: connectedAt });
    await db.update(creditSessions).set({ lastTickSeq: 100 }).where(eq(creditSessions.id, id));

    const first = await meterNow(id, new Date());
    expect(first.ticksPosted).toBe(MAX_SESSION_MINUTES - 100);
    expect(first.lastTickSeq).toBe(MAX_SESSION_MINUTES);
    expect(await consumeCount(id)).toBe(MAX_SESSION_MINUTES - 100);

    const second = await meterNow(id, new Date(Date.now() + MINUTE_MS));
    expect(second.ticksPosted).toBe(0);
    expect(await consumeCount(id)).toBe(MAX_SESSION_MINUTES - 100);
  });

  it('(c) refuses billableMinutes above max(240, drawn) and writes NOTHING', async () => {
    const ctx = await setup();
    const id = await openSession(ctx, 'presence');
    const meetingId = await meetingIdOf(id);
    const balanceBefore = await walletBalance(ctx.walletId);
    const sessionBefore = await creditSessionsRepository.findById(id);
    const footprintBefore = await writeFootprint(ctx.walletId, id);

    const refused = creditSessionsRepository.settleFromPresence(
      figures(id, meetingId, {
        billableMinutes: MAX_SESSION_MINUTES + 1,
        topUpToTickSeq: MAX_SESSION_MINUTES + 1,
      })
    );
    await expect(refused).rejects.toBeInstanceOf(SettlementRefusedError);
    await expect(refused).rejects.toMatchObject({ guard: 'figure_exceeds_bound' });

    expect(await consumeCount(id)).toBe(0);
    expect(await walletBalance(ctx.walletId)).toBe(balanceBefore);
    const sessionAfter = await creditSessionsRepository.findById(id);
    expect(sessionBefore).toBeDefined();
    expect(sessionAfter).toEqual(sessionBefore);
    expect(sessionAfter?.billingFinalizedAt).toBeNull();
    expect(await writeFootprint(ctx.walletId, id)).toEqual(footprintBefore);
  });

  it('(d) refuses topUpToTickSeq above billableMinutes and writes NOTHING', async () => {
    const ctx = await setup();
    const id = await openSession(ctx, 'presence');
    const meetingId = await meetingIdOf(id);
    const balanceBefore = await walletBalance(ctx.walletId);
    const sessionBefore = await creditSessionsRepository.findById(id);
    const footprintBefore = await writeFootprint(ctx.walletId, id);

    const refused = creditSessionsRepository.settleFromPresence(
      figures(id, meetingId, { billableMinutes: 10, topUpToTickSeq: 11 })
    );
    await expect(refused).rejects.toBeInstanceOf(SettlementRefusedError);
    await expect(refused).rejects.toMatchObject({ guard: 'figure_exceeds_bound' });

    expect(await consumeCount(id)).toBe(0);
    expect(await walletBalance(ctx.walletId)).toBe(balanceBefore);
    const sessionAfter = await creditSessionsRepository.findById(id);
    expect(sessionBefore).toBeDefined();
    expect(sessionAfter).toEqual(sessionBefore);
    expect(sessionAfter?.billingFinalizedAt).toBeNull();
    expect(await writeFootprint(ctx.walletId, id)).toEqual(footprintBefore);
  });

  it('(e) a legacy session already drawn to 4,233 settles in full with no new tick', async () => {
    const ctx = await setup();
    const id = await openSession(ctx, 'presence');
    const meetingId = await meetingIdOf(id);
    await db
      .update(creditSessions)
      .set({ lastTickSeq: 4233, connectedMinutes: 4233 })
      .where(eq(creditSessions.id, id));

    const res = await creditSessionsRepository.settleFromPresence(
      figures(id, meetingId, {
        billableMinutes: 4233,
        actualMinutes: 4233,
        topUpFromTickSeq: 4234,
        topUpToTickSeq: 4233,
        minutesAlreadyDrawn: 4233,
      })
    );
    expect(res.alreadySettled).toBe(false);
    expect(res.ticksPosted).toBe(0);
    expect(res.session.connectedMinutes).toBe(4233);
    expect(res.session.billingFinalizedAt).not.toBeNull();
    expect(await consumeCount(id)).toBe(0);
  });
});
