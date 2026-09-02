import { describe, it, expect } from 'vitest';
import type { SessionStatement } from '@balo/shared/credit';
import { toSessionStatementView, isStatementDownloadable } from './session-statement-view';

const CLIENT_MONEY: SessionStatement = {
  lens: 'client',
  block: {
    lens: 'client',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    amountAudMinor: 15_000,
    ratePerMinuteMinor: 333,
    settlementStatus: 'not_required',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
  context: {
    occurredAtIso: '2026-08-12T10:00:00.000Z',
    title: 'Static analysis walkthrough',
    counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
    meetingId: 'meeting_1',
    cancelled: false,
  },
};

const CLIENT_ZERO: SessionStatement = {
  lens: 'client',
  block: { ...CLIENT_MONEY.block, settlementShape: 'missed_call' },
  context: CLIENT_MONEY.context,
};

const CLIENT_PENDING: SessionStatement = {
  lens: 'client',
  block: { ...CLIENT_MONEY.block, state: 'pending', durationMinutes: 0, amountAudMinor: 0 },
  context: CLIENT_MONEY.context,
};

const CLIENT_CANCELLED: SessionStatement = {
  lens: 'client',
  block: CLIENT_PENDING.block,
  context: { ...CLIENT_MONEY.context, cancelled: true },
};

const EXPERT_MONEY: SessionStatement = {
  lens: 'expert',
  block: {
    lens: 'expert',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    earningsAudMinor: 11_250,
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
  context: {
    occurredAtIso: '2026-08-12T10:00:00.000Z',
    title: 'Static analysis walkthrough',
    counterparty: { name: 'Northwind Industrial', orgLabel: null },
    meetingId: 'meeting_1',
    cancelled: false,
    payout: { reference: 'payout_1', recordedAtIso: '2026-08-12T11:00:00.000Z' },
  },
};

describe('toSessionStatementView', () => {
  it('derives mode "money" for a finalized, non-zero shape', () => {
    const view = toSessionStatementView(CLIENT_MONEY);
    expect(view.mode).toEqual({ kind: 'money' });
    expect(view.lens).toBe('client');
  });

  it('derives mode "zero" for missed_call / abandoned_wait', () => {
    expect(toSessionStatementView(CLIENT_ZERO).mode).toEqual({ kind: 'zero' });
    const abandoned = toSessionStatementView({
      ...CLIENT_MONEY,
      block: { ...CLIENT_MONEY.block, settlementShape: 'abandoned_wait' },
    });
    expect(abandoned.mode).toEqual({ kind: 'zero' });
  });

  it('derives mode "pending" for a pending, non-cancelled session', () => {
    expect(toSessionStatementView(CLIENT_PENDING).mode).toEqual({ kind: 'pending' });
  });

  it('derives mode "cancelled" for a pending session whose context is cancelled', () => {
    expect(toSessionStatementView(CLIENT_CANCELLED).mode).toEqual({ kind: 'cancelled' });
  });

  it('the client arm never carries a `payout` key (structural concealment)', () => {
    const view = toSessionStatementView(CLIENT_MONEY);
    expect(view).not.toHaveProperty('payout');
  });

  it('the expert arm carries the payout reference through unchanged', () => {
    const view = toSessionStatementView(EXPERT_MONEY);
    if (view.lens !== 'expert') throw new Error('expected expert lens');
    expect(view.payout).toEqual({
      reference: 'payout_1',
      recordedAtIso: '2026-08-12T11:00:00.000Z',
    });
  });

  it('carries the shared header fields through unchanged', () => {
    const view = toSessionStatementView(CLIENT_MONEY);
    expect(view.sessionId).toBe('session_1');
    expect(view.occurredAtIso).toBe('2026-08-12T10:00:00.000Z');
    expect(view.title).toBe('Static analysis walkthrough');
    expect(view.counterparty).toEqual({ name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' });
    expect(view.meetingId).toBe('meeting_1');
  });
});

describe('isStatementDownloadable', () => {
  it('is true ONLY for mode "money"', () => {
    expect(isStatementDownloadable(toSessionStatementView(CLIENT_MONEY))).toBe(true);
    expect(isStatementDownloadable(toSessionStatementView(CLIENT_ZERO))).toBe(false);
    expect(isStatementDownloadable(toSessionStatementView(CLIENT_PENDING))).toBe(false);
    expect(isStatementDownloadable(toSessionStatementView(CLIENT_CANCELLED))).toBe(false);
  });
});
