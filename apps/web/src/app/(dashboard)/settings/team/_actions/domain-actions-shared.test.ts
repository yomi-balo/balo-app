import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy runtime deps so the module under test loads with just zod —
// `@balo/db` is now a VALUE import (`companiesRepository` powers `assertRealCompany`),
// so it must be mocked to avoid pulling in the real DB client; authz/join-request-shared
// likewise pull in the DB client, which we don't need for these pure helpers.
const mockHasCapability = vi.fn();
const mockFindById = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { MANAGE_MEMBERS: 'manage_members' },
}));
vi.mock('@balo/db', () => ({
  companiesRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));
vi.mock('./join-request-shared', () => ({
  partyScopeOf: (request: { partyType: 'company' | 'agency'; partyId: string }) =>
    request.partyType === 'company'
      ? { companyId: request.partyId }
      : { agencyId: request.partyId },
}));

import {
  assertRealCompany,
  domainInputSchema,
  domainParseError,
  manageGate,
  mapAddOutcomeToResult,
  revalidateTargetForParty,
} from './domain-actions-shared';

const PARTY_ID = '11111111-1111-4111-8111-111111111111';

function parseDomain(domain: string): ReturnType<typeof domainInputSchema.safeParse> {
  return domainInputSchema.safeParse({ partyType: 'company', partyId: PARTY_ID, domain });
}

describe('domainInputSchema', () => {
  it('accepts a clean domain and returns the normalised value', () => {
    const result = parseDomain('acme.com');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domain).toBe('acme.com');
  });

  it('normalises a pasted URL with protocol + path before accepting', () => {
    const result = parseDomain('HTTPS://Acme.com/join');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domain).toBe('acme.com');
  });

  it('rejects an empty domain with the "Enter a domain" copy', () => {
    const result = parseDomain('   ');
    expect(result.success).toBe(false);
    if (!result.success) expect(domainParseError(result.error)).toBe('Enter a domain to add.');
  });

  it('rejects a malformed domain with the actionable format copy', () => {
    for (const bad of ['not a domain', 'acme', '@@', 'nope..com']) {
      const result = parseDomain(bad);
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = domainParseError(result.error);
        // '@@' collapses to empty → the empty copy; the rest are format failures.
        expect(
          message === 'Enter a domain to add.' ||
            message ===
              "That doesn't look like a domain. Enter it like acme.com — no https:// or @."
        ).toBe(true);
      }
    }
  });

  it('rejects a bad partyId with a generic (non-domain) error', () => {
    const result = domainInputSchema.safeParse({
      partyType: 'company',
      partyId: 'not-a-uuid',
      domain: 'acme.com',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(domainParseError(result.error)).toBe('Invalid request.');
  });
});

describe('mapAddOutcomeToResult', () => {
  it('maps captured to success', () => {
    expect(
      mapAddOutcomeToResult(
        { outcome: 'captured', partyType: 'company', source: 'admin_added' },
        'acme.com'
      )
    ).toEqual({
      success: true,
    });
  });

  it('maps already_owned to the "already on your list" copy', () => {
    expect(mapAddOutcomeToResult({ outcome: 'already_owned' }, 'northwind.com')).toEqual({
      success: false,
      error: 'northwind.com is already on your list.',
    });
  });

  it('maps blocked_domain to the freemail copy', () => {
    const result = mapAddOutcomeToResult(
      { outcome: 'skipped', reason: 'blocked_domain' },
      'gmail.com'
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('personal email provider');
  });

  it('maps already_claimed to the single-owner copy (never names the other org)', () => {
    const result = mapAddOutcomeToResult(
      { outcome: 'skipped', reason: 'already_claimed' },
      'acme.com'
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already connected to another organisation');
      expect(result.error).not.toContain('@');
    }
  });

  it('maps not_applicable to the "Enter a domain" copy', () => {
    expect(mapAddOutcomeToResult({ outcome: 'not_applicable' }, '')).toEqual({
      success: false,
      error: 'Enter a domain to add.',
    });
  });
});

describe('revalidateTargetForParty', () => {
  it('maps company to /settings/team and agency to /expert/settings', () => {
    expect(revalidateTargetForParty('company')).toBe('/settings/team');
    expect(revalidateTargetForParty('agency')).toBe('/expert/settings');
  });
});

describe('assertRealCompany', () => {
  const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null (allowed) for a real, non-personal company', async () => {
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: false });
    await expect(assertRealCompany(COMPANY_ID)).resolves.toBeNull();
    expect(mockFindById).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('denies a personal-workspace company', async () => {
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: true });
    await expect(assertRealCompany(COMPANY_ID)).resolves.toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
  });

  it('denies a company that no longer exists (undefined)', async () => {
    mockFindById.mockResolvedValue(undefined);
    await expect(assertRealCompany(COMPANY_ID)).resolves.toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
  });
});

describe('manageGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null (allowed) when the actor holds MANAGE_MEMBERS', async () => {
    mockHasCapability.mockResolvedValue(true);
    await expect(manageGate({ id: 'u1' }, 'company', PARTY_ID)).resolves.toBeNull();
    expect(mockHasCapability).toHaveBeenCalledWith({ id: 'u1' }, 'manage_members', {
      companyId: PARTY_ID,
    });
  });

  it('returns a deny result when the actor lacks the capability', async () => {
    mockHasCapability.mockResolvedValue(false);
    await expect(manageGate({ id: 'u1' }, 'agency', PARTY_ID)).resolves.toEqual({
      success: false,
      error: 'You do not have permission to do this.',
    });
    // Agency scope is branched off partyType, not silently a company scope.
    expect(mockHasCapability).toHaveBeenCalledWith({ id: 'u1' }, 'manage_members', {
      agencyId: PARTY_ID,
    });
  });
});
