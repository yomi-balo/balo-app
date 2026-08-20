import { describe, it, expect } from 'vitest';
import type { CalendarSubscription } from '@balo/db';
import {
  buildSubscriptionPlan,
  SUBSCRIPTION_RENEWAL_LEAD_MS,
  SUBSCRIPTION_PLAN_MAX_ACTIONS,
  type VendorSubscriptionView,
} from './subscription-plan.js';
import { SUBSCRIPTION_EXPIRY_ALERT_MS } from '../../jobs/calendar-subscription-monitor.js';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const PREFIX = 'https://api.balo.expert/webhooks/apiroc/calendar/';

let rowCounter = 0;
function row(overrides: Partial<CalendarSubscription> = {}): CalendarSubscription {
  rowCounter += 1;
  const id = overrides.id ?? `11111111-1111-4111-8111-${String(rowCounter).padStart(12, '0')}`;
  return {
    id,
    connectionId: 'connection-1',
    calendarId: 'cal-1',
    webhookSubscriptionId: `wsub-${id}`,
    endpointSecret: 'encrypted-secret',
    webhookUrl: `${PREFIX}${id}`,
    expiration: null,
    expirationSyncedAt: null,
    lastDeliveryAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as CalendarSubscription;
}

function vendorRecord(overrides: Partial<VendorSubscriptionView> = {}): VendorSubscriptionView {
  return { id: 'wsub-x', url: `${PREFIX}some-row`, expiration: null, ...overrides };
}

const baseInput = {
  desiredCalendarIds: [] as string[],
  baloRows: [] as CalendarSubscription[],
  vendorRecords: [] as VendorSubscriptionView[],
  knownLiveRowIds: new Set<string>(),
  webhookUrlPrefix: PREFIX,
  now: NOW,
  force: false,
};

describe('buildSubscriptionPlan (BAL-468 §8.3)', () => {
  it('empty everything → empty plan', () => {
    const plan = buildSubscriptionPlan(baseInput);
    expect(plan).toEqual({ creates: [], deletes: [], stamps: [], cappedActions: 0 });
  });

  it('one desired calendar, no rows → one missing create with supersedes: null', () => {
    const plan = buildSubscriptionPlan({ ...baseInput, desiredCalendarIds: ['cal-1'] });
    expect(plan.creates).toEqual([{ calendarId: 'cal-1', reason: 'missing', supersedes: null }]);
    expect(plan.deletes).toEqual([]);
  });

  it('canonical row far from expiry, present at vendor → no create, one stamp', () => {
    const r = row({ webhookSubscriptionId: 'wsub-1' });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [
        vendorRecord({
          id: 'wsub-1',
          expiration: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.stamps).toHaveLength(1);
    expect(plan.stamps[0]?.rowId).toBe(r.id);
  });

  it('canonical row inside the 72h lead → one renew create carrying supersedes', () => {
    const r = row({ webhookSubscriptionId: 'wsub-1' });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [
        vendorRecord({
          id: 'wsub-1',
          expiration: new Date(NOW.getTime() + 1 * 60 * 60 * 1000).toISOString(),
        }),
      ],
    });
    expect(plan.creates).toEqual([
      {
        calendarId: 'cal-1',
        reason: 'renew',
        supersedes: { rowId: r.id, webhookSubscriptionId: 'wsub-1' },
      },
    ]);
  });

  it('canonical row absent from the vendor list → vendor_missing create (not silently ignored)', () => {
    const r = row({ webhookSubscriptionId: 'wsub-gone' });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [],
    });
    expect(plan.creates).toEqual([
      {
        calendarId: 'cal-1',
        reason: 'vendor_missing',
        supersedes: { rowId: r.id, webhookSubscriptionId: 'wsub-gone' },
      },
    ]);
    // Absent from the vendor list ⇒ no stamp either.
    expect(plan.stamps).toEqual([]);
  });

  it('force: true → every desired calendar creates, regardless of expiry', () => {
    const r = row({ webhookSubscriptionId: 'wsub-1' });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [
        vendorRecord({
          id: 'wsub-1',
          expiration: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      force: true,
    });
    expect(plan.creates).toEqual([
      {
        calendarId: 'cal-1',
        reason: 'forced',
        supersedes: { rowId: r.id, webhookSubscriptionId: 'wsub-1' },
      },
    ]);
  });

  it('two live rows for one calendarId → newest is canonical, older is a superseded delete', () => {
    const older = row({
      id: '11111111-1111-4111-8111-000000000001',
      webhookSubscriptionId: 'wsub-older',
      createdAt: new Date(NOW.getTime() - 1000),
    });
    const newer = row({
      id: '11111111-1111-4111-8111-000000000002',
      webhookSubscriptionId: 'wsub-newer',
      createdAt: NOW,
    });
    // baloRows arrives NEWEST FIRST, per listLiveByConnectionId's contract.
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [newer, older],
      vendorRecords: [
        vendorRecord({
          id: 'wsub-newer',
          expiration: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        vendorRecord({
          id: 'wsub-older',
          expiration: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([
      { webhookSubscriptionId: 'wsub-older', rowId: older.id, reason: 'superseded' },
    ]);
  });

  it('a live row for an undesired calendarId → undesired delete, plus its siblings', () => {
    const canonical = row({ calendarId: 'cal-x', webhookSubscriptionId: 'wsub-canon' });
    const sibling = row({
      calendarId: 'cal-x',
      webhookSubscriptionId: 'wsub-sibling',
      createdAt: new Date(NOW.getTime() - 1000),
    });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: [], // cal-x no longer desired
      baloRows: [canonical, sibling],
      vendorRecords: [],
    });
    expect(plan.deletes).toEqual(
      expect.arrayContaining([
        { webhookSubscriptionId: 'wsub-canon', rowId: canonical.id, reason: 'undesired' },
        { webhookSubscriptionId: 'wsub-sibling', rowId: sibling.id, reason: 'superseded' },
      ])
    );
    expect(plan.deletes).toHaveLength(2);
  });

  it('vendor record with a matching url prefix and a dead row id → orphan delete', () => {
    const deadId = '22222222-2222-4222-8222-222222222222';
    const plan = buildSubscriptionPlan({
      ...baseInput,
      vendorRecords: [vendorRecord({ id: 'wsub-orphan', url: `${PREFIX}${deadId}` })],
      knownLiveRowIds: new Set(),
    });
    expect(plan.deletes).toEqual([
      { webhookSubscriptionId: 'wsub-orphan', rowId: null, reason: 'orphan' },
    ]);
  });

  it('⚠ vendor record whose row id is live on ANOTHER connection → NOT deleted, no log (edge case 1)', () => {
    const liveElsewhereId = '33333333-3333-4333-8333-333333333333';
    const plan = buildSubscriptionPlan({
      ...baseInput,
      vendorRecords: [vendorRecord({ id: 'wsub-shared', url: `${PREFIX}${liveElsewhereId}` })],
      knownLiveRowIds: new Set([liveElsewhereId]),
    });
    expect(plan.deletes).toEqual([]);
  });

  it('vendor record with a non-matching url → never touched', () => {
    const plan = buildSubscriptionPlan({
      ...baseInput,
      vendorRecords: [vendorRecord({ id: 'wsub-foreign', url: 'https://someone-else.example/x' })],
      knownLiveRowIds: new Set(),
    });
    expect(plan.deletes).toEqual([]);
  });

  it('expiration as an unparseable / absent string → treated as null, no renewal planned', () => {
    const r = row({ webhookSubscriptionId: 'wsub-1' });
    const unparseable = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [vendorRecord({ id: 'wsub-1', expiration: 'not-a-date' })],
    });
    expect(unparseable.creates).toEqual([]);
    expect(unparseable.stamps).toEqual([{ rowId: r.id, expiration: null }]);

    const absent = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [vendorRecord({ id: 'wsub-1', expiration: undefined })],
    });
    expect(absent.creates).toEqual([]);
    expect(absent.stamps).toEqual([{ rowId: r.id, expiration: null }]);
  });

  it('boundary: expiration exactly at now + LEAD → renews (inclusive <=)', () => {
    const r = row({ webhookSubscriptionId: 'wsub-1' });
    const plan = buildSubscriptionPlan({
      ...baseInput,
      desiredCalendarIds: ['cal-1'],
      baloRows: [r],
      vendorRecords: [
        vendorRecord({
          id: 'wsub-1',
          expiration: new Date(NOW.getTime() + SUBSCRIPTION_RENEWAL_LEAD_MS).toISOString(),
        }),
      ],
    });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]?.reason).toBe('renew');
  });

  it('action cap: 40 desired calendars → cappedActions = 15, creates prioritised over deletes', () => {
    const desiredCalendarIds = Array.from({ length: 40 }, (_, i) => `cal-${i}`);
    const plan = buildSubscriptionPlan({ ...baseInput, desiredCalendarIds });
    expect(plan.creates).toHaveLength(SUBSCRIPTION_PLAN_MAX_ACTIONS);
    expect(plan.deletes).toEqual([]);
    expect(plan.cappedActions).toBe(15);
  });

  it('SUBSCRIPTION_RENEWAL_LEAD_MS (72h) is greater than the monitor alert threshold (48h)', () => {
    expect(SUBSCRIPTION_RENEWAL_LEAD_MS).toBeGreaterThan(SUBSCRIPTION_EXPIRY_ALERT_MS);
  });
});
