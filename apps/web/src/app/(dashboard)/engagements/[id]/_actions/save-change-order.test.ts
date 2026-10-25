import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  DANA,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
  makeLine,
  makeMilestone,
  makeOrder,
  makeProject,
} from '@/test/change-order-fixtures';

const ORDER_ID = 'b0000000-0000-4000-8000-0000000000a1';
const MS_ID = 'b0000000-0000-4000-8000-0000000000b1';
const OTHER_MS_ID = 'b0000000-0000-4000-8000-0000000000b2';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (html: string) => `S:${html}`,
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

vi.mock('@/lib/authz', () => ({ hasCapability: vi.fn(), CAPABILITIES: {} }));
const mockHasExpertCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockEffectivePrice,
  mockList,
  mockCreateDraft,
  mockReplaceLines,
  mockSend,
  ChangeOrderCoherenceError,
} = vi.hoisted(() => {
  class ChangeOrderCoherenceError extends Error {
    constructor(public readonly rule: string) {
      super(rule);
    }
  }
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockEffectivePrice: vi.fn(),
    mockList: vi.fn(),
    mockCreateDraft: vi.fn(),
    mockReplaceLines: vi.fn(),
    mockSend: vi.fn(),
    ChangeOrderCoherenceError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: {
    effectivePriceCents: (...a: unknown[]) => mockEffectivePrice(...a),
    listForEngagement: (...a: unknown[]) => mockList(...a),
    createDraft: (...a: unknown[]) => mockCreateDraft(...a),
    replaceLines: (...a: unknown[]) => mockReplaceLines(...a),
    send: (...a: unknown[]) => mockSend(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  ChangeOrderCoherenceError,
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderNotFoundError: class extends Error {},
  ChangeOrderPendingError: class extends Error {},
  InvalidChangeOrderTransitionError: class extends Error {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
  MilestoneChangePendingError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: { CHANGE_ORDER_SENT: 'engagement_change_order_sent' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { saveChangeOrderAction } from './save-change-order';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const NOTE = 'Adds a reporting dashboard and tightens the discovery milestone.';
const ADD_LINE = { op: 'add' as const, title: 'Reporting dashboard' };
const base = { engagementId: ENGAGEMENT_ID, note: NOTE, lines: [ADD_LINE], send: false };

const saved = makeOrder({
  id: ORDER_ID,
  status: 'draft',
  note: NOTE,
  priceDeltaCents: 100_000,
  lines: [makeLine({ op: 'add' })],
});
const sent = makeOrder({
  id: ORDER_ID,
  status: 'sent',
  note: NOTE,
  priceDeltaCents: 100_000,
  sentAt: new Date('2026-10-15T12:00:00Z'),
  sentByUserId: CHARLES.id,
  lines: [
    makeLine({ op: 'add' }),
    makeLine({ id: 'l2', op: 'edit', engagementMilestoneId: MS_ID }),
    makeLine({ id: 'l3', op: 'remove', engagementMilestoneId: OTHER_MS_ID }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    id: CHARLES.id,
    firstName: 'Charles',
    lastName: 'Ng',
    platformRole: 'user',
    companyId: 'other-company',
    expertProfileId: 'expert-1',
  });
  mockFindEngagement.mockResolvedValue(
    makeProject({
      milestones: [
        makeMilestone({ id: MS_ID, title: 'Discovery' }),
        makeMilestone({ id: OTHER_MS_ID, title: 'Old milestone' }),
      ],
    })
  );
  mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
  mockHasExpertCapability.mockResolvedValue(true);
  mockEffectivePrice.mockResolvedValue(1_000_000);
  mockList.mockResolvedValue([]);
  mockCreateDraft.mockResolvedValue(saved);
  mockReplaceLines.mockResolvedValue(saved);
  mockSend.mockResolvedValue(sent);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
});

describe('saveChangeOrderAction — input and gate', () => {
  it.each([
    ['unknown key', { ...base, extra: true }],
    ['more than 100 lines', { ...base, lines: Array.from({ length: 101 }, () => ADD_LINE) }],
    ['blank line title', { ...base, lines: [{ op: 'add', title: ' ' }] }],
    ['fractional minutes', { ...base, lines: [{ ...ADD_LINE, estimatedMinutes: 1.5 }] }],
    ['negative total', { ...base, newTotalCents: -1 }],
  ])('rejects %s', async (_name, input) => {
    expect(await saveChangeOrderAction(input as never)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('refuses a caller without manage_engagement', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await saveChangeOrderAction(base)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('rejects a new total on a time and materials project', async () => {
    mockFindEngagement.mockResolvedValue(makeProject({ pricingMethod: 'tm' }));
    expect(await saveChangeOrderAction({ ...base, newTotalCents: 1_100_000 })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });
});

describe('saveChangeOrderAction — lines', () => {
  it('refuses an edit line that names no milestone, and an add line that names one', async () => {
    expect(
      await saveChangeOrderAction({ ...base, lines: [{ op: 'edit', title: 'X' }] })
    ).toMatchObject({ success: false, error: 'Invalid request.' });
    expect(
      await saveChangeOrderAction({ ...base, lines: [{ ...ADD_LINE, milestoneId: MS_ID }] })
    ).toMatchObject({ success: false, error: 'Invalid request.' });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('refuses a milestone that is not part of this project before any write', async () => {
    const foreign = 'b0000000-0000-4000-8000-0000000000ff';
    expect(
      await saveChangeOrderAction({
        ...base,
        lines: [{ op: 'remove', title: 'X', milestoneId: foreign }],
      })
    ).toEqual({
      success: false,
      error: 'The delivery plan changed since you loaded the page. Refresh and try again.',
    });
    expect(mockCreateDraft).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('builds repository lines: sanitised description, live title on remove, no values', async () => {
    await saveChangeOrderAction({
      ...base,
      lines: [
        { op: 'add', title: 'New', descriptionText: 'Line one', estimatedMinutes: 90 },
        { op: 'edit', title: 'Discovery (revised)', milestoneId: MS_ID, descriptionText: null },
        { op: 'remove', title: 'ignored', milestoneId: OTHER_MS_ID },
      ],
    });

    const [call] = mockCreateDraft.mock.calls[0] ?? [];
    expect(call.lines).toEqual([
      {
        op: 'add',
        engagementMilestoneId: null,
        title: 'New',
        descriptionHtml: 'S:<p>Line one</p>',
        acceptanceCriteria: null,
        valueCents: null,
        estimatedMinutes: 90,
      },
      {
        op: 'edit',
        engagementMilestoneId: MS_ID,
        title: 'Discovery (revised)',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: null,
        estimatedMinutes: null,
      },
      {
        op: 'remove',
        engagementMilestoneId: OTHER_MS_ID,
        title: 'Old milestone',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: null,
        estimatedMinutes: null,
      },
    ]);
  });
});

describe('saveChangeOrderAction — edit descriptions', () => {
  const RICH = '<p>Alpha <strong>Beta</strong></p>';

  beforeEach(() => {
    mockFindEngagement.mockResolvedValue(
      makeProject({ milestones: [makeMilestone({ id: MS_ID, descriptionHtml: RICH })] })
    );
  });

  it('keeps the live rich description on a title-only edit', async () => {
    await saveChangeOrderAction({
      ...base,
      lines: [{ op: 'edit', title: 'Renamed', milestoneId: MS_ID, descriptionText: 'Alpha Beta' }],
    });
    const [call] = mockCreateDraft.mock.calls[0] ?? [];
    expect(call.lines[0].descriptionHtml).toBe(RICH);
  });

  it('rebuilds the description when the text changed', async () => {
    await saveChangeOrderAction({
      ...base,
      lines: [{ op: 'edit', title: 'Discovery', milestoneId: MS_ID, descriptionText: 'Gamma' }],
    });
    const [call] = mockCreateDraft.mock.calls[0] ?? [];
    expect(call.lines[0].descriptionHtml).toBe('S:<p>Gamma</p>');
  });

  it('refuses a new total above the integer price bound', async () => {
    const result = await saveChangeOrderAction({ ...base, newTotalCents: 2_147_483_648 });
    expect(result.success).toBe(false);
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });
});

describe('saveChangeOrderAction — saving a draft', () => {
  it('opens a fresh draft with the signed expert-side delta from the effective price', async () => {
    const result = await saveChangeOrderAction({ ...base, newTotalCents: 1_100_000 });

    expect(result).toEqual({ success: true });
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: CHARLES.id,
        note: NOTE,
        priceDeltaCents: 100_000,
      })
    );
    expect(mockCreateDraft.mock.calls[0]?.[0]).not.toHaveProperty('fromOrderId');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}/change-order`);
  });

  it('stores no delta when the total is unchanged or absent, and a blank note as null', async () => {
    await saveChangeOrderAction({ ...base, note: '', newTotalCents: 1_000_000 });
    expect(mockCreateDraft.mock.calls[0]?.[0]).toMatchObject({ note: null, priceDeltaCents: null });

    mockCreateDraft.mockClear();
    await saveChangeOrderAction(base);
    expect(mockCreateDraft.mock.calls[0]?.[0]).toMatchObject({ priceDeltaCents: null });
  });

  it('stores a price cut as a negative delta', async () => {
    await saveChangeOrderAction({ ...base, newTotalCents: 800_000 });
    expect(mockCreateDraft.mock.calls[0]?.[0]).toMatchObject({ priceDeltaCents: -200_000 });
  });

  it('turns an open client request into the draft', async () => {
    mockList.mockResolvedValue([
      makeOrder({
        id: ORDER_ID,
        status: 'requested',
        requestedAt: new Date('2026-10-10T00:00:00Z'),
        requestedByUserId: DANA.id,
      }),
    ]);
    await saveChangeOrderAction({ ...base, orderId: ORDER_ID });
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ fromOrderId: ORDER_ID })
    );
  });

  it('replaces the lines of an open draft', async () => {
    mockList.mockResolvedValue([makeOrder({ id: ORDER_ID, status: 'draft' })]);
    await saveChangeOrderAction({ ...base, orderId: ORDER_ID });
    expect(mockReplaceLines).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }));
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('never silently edits an order the composer did not open', async () => {
    mockList.mockResolvedValue([makeOrder({ id: ORDER_ID, status: 'draft' })]);
    expect(await saveChangeOrderAction(base)).toEqual({
      success: false,
      error:
        "There's already a change open on this project. You can start another once it's decided.",
    });
    expect(await saveChangeOrderAction({ ...base, orderId: OTHER_MS_ID })).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    expect(mockReplaceLines).not.toHaveBeenCalled();
  });

  it('says the status changed when the composer holds an order that is gone or already sent', async () => {
    expect(await saveChangeOrderAction({ ...base, orderId: ORDER_ID })).toMatchObject({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    mockList.mockResolvedValue([makeOrder({ id: ORDER_ID, status: 'sent' })]);
    expect(await saveChangeOrderAction({ ...base, orderId: ORDER_ID })).toMatchObject({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});

describe('saveChangeOrderAction — sending', () => {
  it('sends, tracks without amounts, and tells the client CLIENT figures only', async () => {
    const result = await saveChangeOrderAction({ ...base, newTotalCents: 1_100_000, send: true });

    expect(result).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      orderId: ORDER_ID,
      userId: CHARLES.id,
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_sent', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: ORDER_ID,
      pricing_method: 'fixed',
      lines_added: 1,
      lines_edited: 1,
      lines_removed: 1,
      has_price_change: true,
      initiated_by: 'expert',
      distinct_id: CHARLES.id,
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.sent', {
      correlationId: `${ORDER_ID}:sent`,
      engagementId: ENGAGEMENT_ID,
      changeOrderId: ORDER_ID,
      projectTitle: 'CPQ rollout',
      recipientId: 'owner-1',
      actorExpertLabel: 'Charles',
      clientCompanyName: 'Northwind',
      summary: NOTE,
      pricingMethod: 'fixed',
      linesAdded: 1,
      linesEdited: 1,
      linesRemoved: 1,
      clientPriceChangeLabel: 'A$12,500 → A$13,750 (+A$1,250)',
    });
    const payload = JSON.stringify(mockPublish.mock.calls);
    expect(payload).not.toContain('A$10,000');
    expect(payload).not.toContain('A$11,000');
  });

  it('time and materials: tells the client the estimate, with no price label', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({
        pricingMethod: 'tm',
        milestones: [makeMilestone({ id: MS_ID, title: 'Discovery', estimatedMinutes: 3000 })],
      })
    );
    mockSend.mockResolvedValue(
      makeOrder({
        id: ORDER_ID,
        status: 'sent',
        note: NOTE,
        sentAt: new Date(),
        lines: [makeLine({ op: 'add', estimatedMinutes: 600 })],
      })
    );

    await saveChangeOrderAction({
      ...base,
      lines: [{ ...ADD_LINE, estimatedMinutes: 600 }],
      send: true,
    });

    const payload = mockPublish.mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      pricingMethod: 'tm',
      estimateChangeLabel: '50 hrs → 60 hrs (+10 hrs)',
    });
    expect(payload).not.toHaveProperty('clientPriceChangeLabel');
    expect(mockCreateDraft.mock.calls[0]?.[0]).toMatchObject({ priceDeltaCents: null });
  });

  it('a send that fails coherence keeps the saved draft and returns the rule message', async () => {
    mockSend.mockRejectedValue(new ChangeOrderCoherenceError('note_missing'));

    expect(await saveChangeOrderAction({ ...base, send: true })).toEqual({
      success: false,
      error: "Add a short summary of what's changing and why.",
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('still succeeds when the client owner cannot be found (client rules skip)', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    expect(await saveChangeOrderAction({ ...base, send: true })).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledWith(
      'change_order.sent',
      expect.objectContaining({ recipientId: undefined })
    );
  });

  it('never logs the note', async () => {
    await saveChangeOrderAction({ ...base, send: true });
    await saveChangeOrderAction(base);
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(NOTE);
  });
});
