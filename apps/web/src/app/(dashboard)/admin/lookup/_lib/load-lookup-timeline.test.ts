import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

const { mockListTrailForEntity } = vi.hoisted(() => ({ mockListTrailForEntity: vi.fn() }));

vi.mock('@balo/db', () => ({
  auditEventsRepository: { listTrailForEntity: mockListTrailForEntity },
}));

import { loadLookupTimeline } from './load-lookup-timeline';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadLookupTimeline — the authorization proof', () => {
  it('a non-staff user gets { ok: false, reason: forbidden } and the repository is never called', async () => {
    const dto = await loadLookupTimeline(user({ platformRole: 'user' }), {
      type: 'engagement',
      id: 'e1',
    });
    expect(dto).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockListTrailForEntity).not.toHaveBeenCalled();
  });
});

describe('loadLookupTimeline — the type -> audit-entity-type mapping (C7)', () => {
  it('maps "expert" to "expert_profile" — the one member that differs from its Lookup badge', async () => {
    mockListTrailForEntity.mockResolvedValue({ rows: [], hasEarlier: false, earlierCursor: null });
    await loadLookupTimeline(user(), { type: 'expert', id: 'x1' });
    expect(mockListTrailForEntity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'expert_profile', entityId: 'x1' })
    );
  });

  it('maps every other type to itself', async () => {
    mockListTrailForEntity.mockResolvedValue({ rows: [], hasEarlier: false, earlierCursor: null });
    await loadLookupTimeline(user(), { type: 'engagement', id: 'e1' });
    expect(mockListTrailForEntity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'engagement', entityId: 'e1' })
    );
  });

  it('passes authorizedPlatformStaff: true and the page-size limit', async () => {
    mockListTrailForEntity.mockResolvedValue({ rows: [], hasEarlier: false, earlierCursor: null });
    await loadLookupTimeline(user(), { type: 'company', id: 'c1' });
    expect(mockListTrailForEntity).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedPlatformStaff: true, limit: 25 })
    );
  });

  it('forwards a before cursor VERBATIM as an opaque precise string — never through a Date', async () => {
    mockListTrailForEntity.mockResolvedValue({ rows: [], hasEarlier: false, earlierCursor: null });
    // Deliberately carries microsecond digits a `new Date(...)` round-trip would truncate.
    await loadLookupTimeline(user(), {
      type: 'company',
      id: 'c1',
      before: { createdAtPrecise: '2026-06-02 10:15:30.083951+00', seq: 42 },
    });
    const call = mockListTrailForEntity.mock.calls[0]?.[0];
    expect(call.before.createdAtPrecise).toBe('2026-06-02 10:15:30.083951+00');
    expect(call.before.seq).toBe(42);
  });
});

describe('loadLookupTimeline — the DTO projection', () => {
  it('carries no metadata and no actorUserId across the boundary', async () => {
    mockListTrailForEntity.mockResolvedValue({
      rows: [
        {
          id: 'row-1',
          action: 'agency.created',
          createdAt: new Date('2026-06-02T10:15:30.000Z'),
          // Deliberately DIFFERENT microsecond digits than `createdAt`'s own millisecond
          // rendering would suggest — proves `instantKey` below is forwarded from THIS field,
          // never re-derived from `createdAt`/`occurredAtIso` (BAL-555 fix round F1).
          createdAtPrecise: '2026-06-02 10:15:30.000123+00',
          seq: 1,
          metadata: { secret: 'workos-id-should-never-cross' },
          actorUserId: 'user-1',
          actorFirstName: 'MJ',
          actorLastName: null,
          actorPlatformRole: 'admin',
          actorCompanyName: null,
          actorAgencyName: null,
        },
      ],
      hasEarlier: false,
      earlierCursor: null,
    });

    const dto = await loadLookupTimeline(user(), { type: 'agency', id: 'a1' });
    expect(dto.ok).toBe(true);
    if (!dto.ok) return;
    expect(dto.entries).toHaveLength(1);
    const [entry] = dto.entries;
    expect(entry).toEqual({
      id: 'row-1',
      action: 'agency.created',
      summary: 'Agency created — MJ @ Balo',
      occurredAtIso: '2026-06-02T10:15:30.000Z',
      instantKey: '2026-06-02 10:15:30.000123+00',
    });
    expect(JSON.stringify(entry)).not.toContain('workos-id-should-never-cross');
  });

  it('the composed summary matches describeAuditEvent for a null actor', async () => {
    mockListTrailForEntity.mockResolvedValue({
      rows: [
        {
          id: 'row-2',
          action: 'engagement.accepted',
          createdAt: new Date('2026-06-02T10:15:30.000Z'),
          createdAtPrecise: '2026-06-02 10:15:30.000456+00',
          seq: 2,
          metadata: null,
          actorUserId: null,
          actorFirstName: null,
          actorLastName: null,
          actorPlatformRole: null,
          actorCompanyName: null,
          actorAgencyName: null,
        },
      ],
      hasEarlier: false,
      earlierCursor: null,
    });

    const dto = await loadLookupTimeline(user(), { type: 'engagement', id: 'e1' });
    expect(dto.ok).toBe(true);
    if (!dto.ok) return;
    expect(dto.entries[0]?.summary).toBe('Delivery accepted');
  });

  it('BAL-555 fix round F1 — two rows sharing a millisecond but differing in microseconds get DISTINCT instantKeys, never derived from occurredAtIso', async () => {
    mockListTrailForEntity.mockResolvedValue({
      rows: [
        {
          id: 'row-a',
          action: 'engagement.accepted',
          createdAt: new Date('2026-03-01T12:00:00.083Z'),
          createdAtPrecise: '2026-03-01 12:00:00.083999+00',
          seq: 2,
          metadata: null,
          actorUserId: null,
          actorFirstName: null,
          actorLastName: null,
          actorPlatformRole: null,
          actorCompanyName: null,
          actorAgencyName: null,
        },
        {
          id: 'row-b',
          action: 'engagement.changes_requested',
          createdAt: new Date('2026-03-01T12:00:00.083Z'),
          createdAtPrecise: '2026-03-01 12:00:00.083001+00',
          seq: 1,
          metadata: null,
          actorUserId: null,
          actorFirstName: null,
          actorLastName: null,
          actorPlatformRole: null,
          actorCompanyName: null,
          actorAgencyName: null,
        },
      ],
      hasEarlier: false,
      earlierCursor: null,
    });

    const dto = await loadLookupTimeline(user(), { type: 'engagement', id: 'e1' });
    expect(dto.ok).toBe(true);
    if (!dto.ok) return;
    expect(dto.entries[0]?.occurredAtIso).toBe(dto.entries[1]?.occurredAtIso);
    expect(dto.entries[0]?.instantKey).toBe('2026-03-01 12:00:00.083999+00');
    expect(dto.entries[1]?.instantKey).toBe('2026-03-01 12:00:00.083001+00');
    expect(dto.entries[0]?.instantKey).not.toBe(dto.entries[1]?.instantKey);
  });

  it('forwards hasEarlier and carries earlierCursor.createdAtPrecise to the wire DTO VERBATIM', async () => {
    mockListTrailForEntity.mockResolvedValue({
      rows: [],
      hasEarlier: true,
      // Microsecond digits a `.toISOString()` round-trip would truncate — proves the DTO
      // conversion never routes this value through a Date.
      earlierCursor: { createdAtPrecise: '2026-01-01 00:00:00.123456+00', seq: 7 },
    });

    const dto = await loadLookupTimeline(user(), { type: 'engagement', id: 'e1' });
    expect(dto).toEqual({
      ok: true,
      entries: [],
      hasEarlier: true,
      earlier: { createdAtPrecise: '2026-01-01 00:00:00.123456+00', seq: 7 },
    });
  });
});
