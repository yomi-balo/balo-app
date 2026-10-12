import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockGetPartyForStaff,
  mockPublish,
  mockRevalidatePath,
  mockEmitAdded,
  mockEmitRemoved,
  mockEmitReassigned,
  mockLogInfo,
  mockLogError,
} = vi.hoisted(() => ({
  mockGetPartyForStaff: vi.fn(),
  mockPublish: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockEmitAdded: vi.fn(),
  mockEmitRemoved: vi.fn(),
  mockEmitReassigned: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsStaffRepository: {
    getPartyForStaff: (...a: unknown[]) => mockGetPartyForStaff(...a),
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }));
vi.mock('@/lib/logging', () => ({
  log: {
    info: (...a: unknown[]) => mockLogInfo(...a),
    error: (...a: unknown[]) => mockLogError(...a),
    warn: vi.fn(),
  },
}));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));
vi.mock('@/lib/analytics/party-join', () => ({
  emitPartyDomainAdded: (...a: unknown[]) => mockEmitAdded(...a),
  emitPartyDomainRemoved: (...a: unknown[]) => mockEmitRemoved(...a),
  emitPartyDomainReassigned: (...a: unknown[]) => mockEmitReassigned(...a),
}));

import {
  afterDomainChange,
  loadPartyTarget,
  ownedByOther,
  parseDomain,
  saveFailed,
  successMessage,
  toOwnerView,
  type DomainChange,
} from './staff-domain-action';

const ACME = { partyType: 'company', partyId: 'c-1', partyName: 'Acme' } as const;
const GLOBEX = { partyType: 'agency', partyId: 'a-1', partyName: 'Globex' } as const;

const OWNER = {
  domainId: 'd-1',
  domain: 'acme.com',
  partyType: 'company',
  partyId: 'c-1',
  partyName: 'Acme',
  memberCount: 3,
  source: 'auto_captured',
  createdAt: new Date('2026-10-03T08:00:00.000Z'),
  createdBy: { firstName: 'Dana', lastName: 'Lee' },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
});

describe('parseDomain', () => {
  it('cleans pasted input', () => {
    expect(parseDomain(' HTTPS://Acme.co.nz/path ')).toEqual({ ok: true, domain: 'acme.co.nz' });
  });

  it('rejects blank and malformed input on the domain field', () => {
    expect(parseDomain('  ')).toMatchObject({
      ok: false,
      result: { success: false, field: 'domain', error: 'Enter a domain to add.' },
    });
    expect(parseDomain('not a domain')).toMatchObject({
      ok: false,
      result: {
        field: 'domain',
        error: 'Enter a domain like acme.co.nz, without https:// or @.',
      },
    });
  });
});

describe('owner projection', () => {
  it('serialises dates and joins the creator name', () => {
    expect(toOwnerView(OWNER)).toEqual({
      domainId: 'd-1',
      partyType: 'company',
      partyId: 'c-1',
      partyName: 'Acme',
      memberCount: 3,
      source: 'auto_captured',
      createdAt: '2026-10-03T08:00:00.000Z',
      createdByName: 'Dana Lee',
    });
  });

  it('maps a nameless or missing creator to null', () => {
    expect(toOwnerView({ ...OWNER, createdBy: null }).createdByName).toBeNull();
    expect(
      toOwnerView({ ...OWNER, createdBy: { firstName: null, lastName: null } }).createdByName
    ).toBeNull();
  });

  it('ownedByOther carries the code and the owner', () => {
    expect(ownedByOther(OWNER)).toMatchObject({
      success: false,
      code: 'owned_by_other',
      error: 'acme.com belongs to Acme',
      owner: { domainId: 'd-1' },
    });
  });
});

describe('loadPartyTarget', () => {
  it('projects the summary and passes undefined through', async () => {
    mockGetPartyForStaff.mockResolvedValueOnce({
      partyType: 'company',
      partyId: 'c-1',
      name: 'Acme',
      isPersonal: true,
      memberCount: 1,
    });
    expect(await loadPartyTarget('company', 'c-1')).toEqual({
      partyType: 'company',
      partyId: 'c-1',
      partyName: 'Acme',
      isPersonal: true,
    });
    mockGetPartyForStaff.mockResolvedValueOnce(undefined);
    expect(await loadPartyTarget('company', 'nope')).toBeUndefined();
  });
});

describe('saveFailed', () => {
  it('logs the error and returns the generic copy', () => {
    const result = saveFailed('Failed to x', { partyId: 'c-1' }, new Error('boom'));
    expect(result).toEqual({
      success: false,
      error: "Couldn't save that change. Nothing was changed — try again.",
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to x',
      expect.objectContaining({ partyId: 'c-1', error: 'boom' })
    );
  });

  it('stringifies a non-Error throw', () => {
    saveFailed('Failed to x', {}, 'plain');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to x',
      expect.objectContaining({ error: 'plain', stack: undefined })
    );
  });
});

describe('successMessage', () => {
  it('uses the design status lines', () => {
    expect(
      successMessage({
        kind: 'added',
        actorUserId: 'u',
        party: ACME,
        domainId: 'd',
        domain: 'acme.com',
      })
    ).toBe('acme.com added to Acme. Owners and admins have been notified.');
    expect(
      successMessage({
        kind: 'removed',
        actorUserId: 'u',
        party: ACME,
        domainId: 'd',
        domain: 'acme.com',
        source: 'admin_added',
      })
    ).toBe('acme.com removed from Acme. Owners and admins have been notified.');
    expect(
      successMessage({
        kind: 'reassigned',
        actorUserId: 'u',
        from: ACME,
        to: GLOBEX,
        removedDomainId: 'r',
        addedDomainId: 'a',
        domain: 'acme.com',
      })
    ).toBe('acme.com moved from Acme to Globex. Owners and admins of both have been notified.');
  });
});

describe('afterDomainChange', () => {
  it('added: logs, tracks, publishes with the new row id, revalidates both surfaces', () => {
    afterDomainChange({
      kind: 'added',
      actorUserId: 'staff-1',
      party: ACME,
      domainId: 'row-new',
      domain: 'acme.com',
    });

    expect(mockEmitAdded).toHaveBeenCalledWith('company', 'admin_added', 'staff-1');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('party.domain_added', {
      correlationId: 'row-new',
      partyType: 'company',
      partyId: 'c-1',
      partyName: 'Acme',
      domain: 'acme.com',
    });
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Party domain added by staff',
      expect.objectContaining({ domainId: 'row-new', actorUserId: 'staff-1' })
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/domains/company/c-1');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/settings/team');
  });

  it('removed: tracks the removed source, publishes with the removed row id, agency path', () => {
    afterDomainChange({
      kind: 'removed',
      actorUserId: 'staff-1',
      party: GLOBEX,
      domainId: 'row-old',
      domain: 'globex.com',
      source: 'auto_captured',
    });

    expect(mockEmitRemoved).toHaveBeenCalledWith('agency', 'auto_captured', 'staff-1');
    expect(mockPublish).toHaveBeenCalledWith('party.domain_removed', {
      correlationId: 'row-old',
      partyType: 'agency',
      partyId: 'a-1',
      partyName: 'Globex',
      domain: 'globex.com',
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/domains/agency/a-1');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/expert/settings');
  });

  it('reassigned: ONLY the reassigned event, two publishes to two parties, both revalidated', () => {
    afterDomainChange({
      kind: 'reassigned',
      actorUserId: 'staff-1',
      from: ACME,
      to: GLOBEX,
      removedDomainId: 'row-old',
      addedDomainId: 'row-new',
      domain: 'acme.com',
    });

    expect(mockEmitReassigned).toHaveBeenCalledWith('company', 'agency', 'staff-1');
    expect(mockEmitAdded).not.toHaveBeenCalled();
    expect(mockEmitRemoved).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledWith(
      'party.domain_removed',
      expect.objectContaining({ correlationId: 'row-old', partyId: 'c-1' })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'party.domain_added',
      expect.objectContaining({ correlationId: 'row-new', partyId: 'a-1' })
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/domains/company/c-1');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/domains/agency/a-1');
  });

  it('truncates a >200-char party name to the publish bound with an ellipsis', () => {
    afterDomainChange({
      kind: 'added',
      actorUserId: 'staff-1',
      party: { ...ACME, partyName: 'A'.repeat(300) },
      domainId: 'row-new',
      domain: 'acme.com',
    });
    const payload = mockPublish.mock.calls[0]?.[1] as { partyName: string };
    expect(payload.partyName).toHaveLength(200);
    expect(payload.partyName.endsWith('…')).toBe(true);
  });

  it('leaves a name at the bound untouched', () => {
    afterDomainChange({
      kind: 'added',
      actorUserId: 'staff-1',
      party: { ...ACME, partyName: 'A'.repeat(200) },
      domainId: 'row-new',
      domain: 'acme.com',
    });
    expect((mockPublish.mock.calls[0]?.[1] as { partyName: string }).partyName).toBe(
      'A'.repeat(200)
    );
  });

  it('one failing step does not skip the rest, and each failure is logged', () => {
    mockEmitAdded.mockImplementationOnce(() => {
      throw new Error('posthog down');
    });
    mockPublish.mockImplementationOnce(() => {
      throw new Error('publish sync throw');
    });
    afterDomainChange({
      kind: 'added',
      actorUserId: 'staff-1',
      party: ACME,
      domainId: 'row-new',
      domain: 'acme.com',
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/domains/company/c-1');
    expect(mockLogError).toHaveBeenCalledTimes(2);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ step: 'analytics' })
    );
  });

  it('never throws when a side effect fails — it logs instead', () => {
    mockRevalidatePath.mockImplementationOnce(() => {
      throw new Error('revalidate boom');
    });
    const change: DomainChange = {
      kind: 'added',
      actorUserId: 'staff-1',
      party: ACME,
      domainId: 'row-new',
      domain: 'acme.com',
    };

    expect(() => afterDomainChange(change)).not.toThrow();
    expect(mockLogError).toHaveBeenCalledWith(
      'A post-commit step failed after a staff party-domain change',
      expect.objectContaining({ kind: 'added', step: 'revalidate', error: 'revalidate boom' })
    );
  });

  it('swallows a rejected publish promise', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue down'));
    expect(() =>
      afterDomainChange({
        kind: 'added',
        actorUserId: 'staff-1',
        party: ACME,
        domainId: 'row-new',
        domain: 'acme.com',
      })
    ).not.toThrow();
    await Promise.resolve();
  });
});
