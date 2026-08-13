import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

/**
 * BAL-421 — unit tests for the ENGAGEMENT-capability web seam (ADR-1046), mirroring the shape
 * of the sibling `platform.test.ts`.
 *
 * ⚠⚠ `@balo/shared/authz` IS REAL, EXACTLY AS IN `platform.test.ts` ("the pure map is REAL so
 * the allow/deny logic is exercised end-to-end through the seam"). Only the three repository
 * reads are mocked. That is what makes these tests capable of failing: if someone re-spelled
 * the holder rule inside `engagement.ts` — the one thing its docblock forbids — a mocked core
 * would keep this file green while the two apps silently disagreed about who may act.
 *
 * ⚠ THE ROLE MATRIX BELOW IS THE ACT AXIS, WHICH IS DELIBERATELY NARROWER THAN THE VISIBILITY
 * AXIS. Agency role `expert` is REFUSED here and ADMITTED by `actorHasExpertSideVisibility`
 * (pinned in `lib/cases/resolve-case-access.test.ts`). ADR-1046 §7 records both widths as
 * deliberate and permanent — a change that made these two files agree is the regression.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000002';
const AGENCY_ID = 'a0000000-0000-4000-8000-000000000003';
const EXPERT_USER_ID = 'u0000000-0000-4000-8000-000000000004';
const COLLEAGUE_ID = 'u0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

const mockFindEngagement = vi.fn();
const mockFindProfile = vi.fn();
const mockGetMemberRole = vi.fn();

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  expertsRepository: { findProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
}));

import { hasEngagementCapability } from './engagement';
import { log } from '@/lib/logging';

const SUBJECT = { contextType: 'case', contextId: ENGAGEMENT_ID } as const;
const { MANAGE_ENGAGEMENT, HOST_MEETINGS } = ENGAGEMENT_CAPABILITIES;

/** An agency-backed profile, so the agency-role arm is reached. */
function seedAgencyBacked(agencyRole: string | undefined): void {
  mockFindEngagement.mockResolvedValue({ id: ENGAGEMENT_ID, expertProfileId: PROFILE_ID });
  mockFindProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
  mockGetMemberRole.mockResolvedValue(agencyRole);
}

beforeEach(() => {
  vi.clearAllMocks();
  seedAgencyBacked(undefined);
});

describe('hasEngagementCapability — who holds it', () => {
  it('GRANTS the delivering expert', async () => {
    seedAgencyBacked(undefined);
    expect(await hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      true
    );
  });

  it('GRANTS an INDEPENDENT delivering expert with NO agency lookup at all', async () => {
    mockFindEngagement.mockResolvedValue({ id: ENGAGEMENT_ID, expertProfileId: PROFILE_ID });
    mockFindProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });

    expect(await hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      true
    );
    // A null agencyId short-circuits in the pure core. A lookup here would mean the core was
    // bypassed or re-implemented.
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('GRANTS the agency OWNER', async () => {
    seedAgencyBacked('owner');
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      true
    );
  });

  it('GRANTS the agency ADMIN', async () => {
    seedAgencyBacked('admin');
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      true
    );
  });

  /**
   * ⚠⚠ THE LOAD-BEARING REFUSAL. This is the single assertion standing between the act axis
   * and the (wider) visibility axis. An agency colleague with role `expert` READS the whole
   * case surface and cannot ask the client to resolve it. ADR-1046 §7: do not "align" them.
   */
  it('REFUSES agency role `expert` — narrower than visibility, deliberately (ADR-1046 §7)', async () => {
    seedAgencyBacked('expert');
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      false
    );
  });

  it('REFUSES agency role `expert` for HOST_MEETINGS too — the refusal is not token-specific', async () => {
    seedAgencyBacked('expert');
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, HOST_MEETINGS, SUBJECT)).toBe(false);
  });

  it('REFUSES a total stranger who holds no agency membership', async () => {
    seedAgencyBacked(undefined);
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      false
    );
  });

  it('passes the ACTOR being authorized to the agency lookup, never a captured id', async () => {
    // The confused-deputy defence `HostContextReads` documents: a lookup built for one actor
    // must never answer for another.
    seedAgencyBacked('owner');
    await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT);
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, COLLEAGUE_ID);
  });
});

describe('hasEngagementCapability — fails closed, and stays silent about it', () => {
  it('returns false when the engagement is MISSING or SOFT-DELETED', async () => {
    // `findById` filters `deleted_at IS NULL`, so both shapes arrive here as `undefined` and
    // share one answer — which is what stops this seam being an existence oracle.
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      false
    );
    // …and nothing downstream is even asked.
    expect(mockFindProfile).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('returns false when the delivering EXPERT PROFILE is missing', async () => {
    mockFindEngagement.mockResolvedValue({ id: ENGAGEMENT_ID, expertProfileId: PROFILE_ID });
    mockFindProfile.mockResolvedValue(undefined);
    expect(await hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      false
    );
  });

  it('logs IDS ONLY on the missing-engagement branch — never a name, email or join url', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    await hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no live engagement'), {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
      actorId: EXPERT_USER_ID,
    });
  });

  it('does NOT log the ordinary "not a holder" answer — that is noise, not an integrity signal', async () => {
    seedAgencyBacked('expert');
    await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE DOCBLOCK CALLS THIS DELIBERATE: "a repository REJECTION — the database being
 * unreachable — still propagates … swallowing that would turn an outage into a silent uniform
 * deny, which is a worse failure than a 500." Without these two tests, a well-meaning
 * `try/catch … return false` would look like defensive hardening and pass every other test in
 * this file, while converting a database outage into "nobody may act on anything" — with no
 * error anywhere to explain why.
 */
describe('hasEngagementCapability — a repository REJECTION propagates, never a silent deny', () => {
  it('propagates a failure of the ENGAGEMENT read', async () => {
    mockFindEngagement.mockRejectedValue(new Error('connection refused'));
    await expect(
      hasEngagementCapability({ id: EXPERT_USER_ID }, MANAGE_ENGAGEMENT, SUBJECT)
    ).rejects.toThrow('connection refused');
  });

  it('propagates a failure of the AGENCY-ROLE read', async () => {
    mockFindEngagement.mockResolvedValue({ id: ENGAGEMENT_ID, expertProfileId: PROFILE_ID });
    mockFindProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
    mockGetMemberRole.mockRejectedValue(new Error('statement timeout'));
    await expect(
      hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)
    ).rejects.toThrow('statement timeout');
  });
});

/**
 * "NO BRANCH ON `capability`. The token is handed straight to the pure core, so both tokens
 * traverse the identical repository sequence." A resolver that grew a per-token shortcut would
 * be the start of a second holder rule.
 */
describe('hasEngagementCapability — one path for both tokens', () => {
  it.each([
    ['manage_engagement', MANAGE_ENGAGEMENT],
    ['host_meetings', HOST_MEETINGS],
  ])('issues the identical read sequence for %s', async (_label, capability) => {
    seedAgencyBacked('owner');
    await hasEngagementCapability({ id: COLLEAGUE_ID }, capability, SUBJECT);
    expect(mockFindEngagement).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(mockFindProfile).toHaveBeenCalledWith(PROFILE_ID);
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, COLLEAGUE_ID);
  });

  it('grants BOTH tokens to the agency owner — the holder set is one set', async () => {
    seedAgencyBacked('owner');
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, MANAGE_ENGAGEMENT, SUBJECT)).toBe(
      true
    );
    expect(await hasEngagementCapability({ id: COLLEAGUE_ID }, HOST_MEETINGS, SUBJECT)).toBe(true);
  });
});
