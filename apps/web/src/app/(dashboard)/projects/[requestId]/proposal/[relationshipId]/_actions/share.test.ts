import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000099';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const LINK_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindRequest = vi.fn();
const mockFindProposal = vi.fn();
const mockCreateLink = vi.fn();
const mockRevokeLink = vi.fn();
const mockListActive = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: { findByIdWithRelations: (...a: unknown[]) => mockFindRequest(...a) },
  proposalsRepository: { findCurrentByRelationship: (...a: unknown[]) => mockFindProposal(...a) },
  proposalShareLinksRepository: {
    create: (...a: unknown[]) => mockCreateLink(...a),
    revoke: (...a: unknown[]) => mockRevokeLink(...a),
    listActiveByRelationship: (...a: unknown[]) => mockListActive(...a),
  },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/project-request/resolve-request-lens', () => ({
  resolveRequestLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const mockEnsurePdf = vi.fn();
vi.mock('@/lib/project-request/proposal/pdf/ensure-client-pdf', () => ({
  ensureClientProposalPdf: (...a: unknown[]) => mockEnsurePdf(...a),
  proposalPdfFileName: () => 'Balo-Proposal-x-v3.pdf',
}));

vi.mock('@/lib/storage/proposal-pdf', () => ({
  proposalPdfKey: (id: string) => `proposals/${id}/client.pdf`,
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    PROJECT_SERVER_EVENTS: events.PROJECT_SERVER_EVENTS,
  };
});

import { shareProposalWithColleague, revokeProposalShareLink } from './share';

const USER = {
  id: USER_ID,
  firstName: 'Dana',
  lastName: 'Okafor',
  email: 'dana@acme-industrial.com',
};
const REQUEST = {
  id: REQUEST_ID,
  title: 'Salesforce CPQ Implementation',
  company: { id: 'company-1', name: 'Acme Industrial' },
  relationships: [{ id: REL_ID }, { id: OTHER_REL_ID }],
};

function primeAuthorizedClient(): void {
  mockGetCurrentUser.mockResolvedValue(USER);
  mockFindRequest.mockResolvedValue(REQUEST);
  mockResolveLens.mockReturnValue({ lens: 'client' });
}

const LINK = { id: LINK_ID, expiresAt: new Date('2026-08-13T00:00:00Z') };

describe('shareProposalWithColleague', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeAuthorizedClient();
    mockFindProposal.mockResolvedValue({ id: PROPOSAL_ID, status: 'submitted', version: 3 });
    mockEnsurePdf.mockResolvedValue(undefined);
    mockCreateLink.mockResolvedValue({ link: LINK, revokedPriorId: null });
    mockPublish.mockResolvedValue(undefined);
  });

  const baseInput = {
    requestId: REQUEST_ID,
    relationshipId: REL_ID,
    recipientEmail: 'alex.chen@northwind.com',
  };

  it('rejects the expert lens with forbidden (client-only surface)', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert' });
    const result = await shareProposalWithColleague(baseInput);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns not_found for a draft (unsubmitted) proposal', async () => {
    mockFindProposal.mockResolvedValue({ id: PROPOSAL_ID, status: 'draft', version: 1 });
    expect(await shareProposalWithColleague(baseInput)).toEqual({ ok: false, error: 'not_found' });
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it('returns not_found when there is no current proposal', async () => {
    mockFindProposal.mockResolvedValue(undefined);
    expect(await shareProposalWithColleague(baseInput)).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns not_found when the request is missing', async () => {
    mockFindRequest.mockResolvedValue(null);
    expect(await shareProposalWithColleague(baseInput)).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns not_found when the relationship is not on the request', async () => {
    const result = await shareProposalWithColleague({
      ...baseInput,
      relationshipId: 'b0000000-0000-4000-8000-000000000abc',
    });
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('rejects a malformed email with validation', async () => {
    const result = await shareProposalWithColleague({
      ...baseInput,
      recipientEmail: 'not-an-email',
    });
    expect(result).toEqual({ ok: false, error: 'validation' });
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it('force-generates the PDF, stores only the token HASH, and publishes with the attachment key', async () => {
    const result = await shareProposalWithColleague({ ...baseInput, note: '  Take a look  ' });
    expect(result).toEqual({ ok: true });

    // PDF force-generated for the exact proposal before publishing.
    expect(mockEnsurePdf).toHaveBeenCalledWith({
      request: REQUEST,
      relationship: { id: REL_ID },
      proposal: { id: PROPOSAL_ID, status: 'submitted', version: 3 },
    });

    // The repo receives the SHA-256 hash — never the raw token.
    const createArg = mockCreateLink.mock.calls[0]?.[0] as {
      tokenHash: string;
      recipientEmail: string;
      note: string | null;
      createdByUserId: string;
    };
    expect(createArg.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createArg.recipientEmail).toBe('alex.chen@northwind.com');
    expect(createArg.note).toBe('Take a look');
    expect(createArg.createdByUserId).toBe(USER_ID);
    expect('shareToken' in createArg).toBe(false);
    expect('rawToken' in createArg).toBe(false);

    // The published payload carries the raw token (URL only) and the PDF attachment.
    const publishArg = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(publishArg[0]).toBe('proposal.shared');
    const payload = publishArg[1];
    expect(payload.correlationId).toBe(LINK_ID);
    expect(payload.recipientEmail).toBe('alex.chen@northwind.com');
    expect(payload.sharerName).toBe('Dana Okafor');
    expect(payload.sharerOrgLabel).toBe('Acme Industrial');
    expect(payload.expiresOn).toBe('13 August 2026');
    expect(payload.attachments).toEqual([
      {
        source: 'r2',
        key: `proposals/${PROPOSAL_ID}/client.pdf`,
        filename: 'Balo-Proposal-x-v3.pdf',
      },
    ]);

    // The stored hash is exactly sha256(rawToken).
    const rawToken = payload.shareToken as string;
    expect(createHash('sha256').update(rawToken).digest('hex')).toBe(createArg.tokenHash);
  });

  it('records DOMAIN-ONLY analytics and lowercases/trims the email', async () => {
    const result = await shareProposalWithColleague({
      ...baseInput,
      recipientEmail: '  Alex.Chen@Northwind.com  ',
    });
    expect(result).toEqual({ ok: true });
    expect(mockCreateLink.mock.calls[0]?.[0].recipientEmail).toBe('alex.chen@northwind.com');
    expect(mockTrack).toHaveBeenCalledWith('project_proposal_share_created', {
      relationship_id: REL_ID,
      recipient_email_domain: 'northwind.com',
      distinct_id: USER_ID,
    });
  });

  it('returns send_failed when the PDF/publish pipeline throws', async () => {
    mockEnsurePdf.mockRejectedValue(new Error('R2 down'));
    expect(await shareProposalWithColleague(baseInput)).toEqual({
      ok: false,
      error: 'send_failed',
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('revokeProposalShareLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeAuthorizedClient();
    mockListActive.mockResolvedValue([{ id: LINK_ID }]);
    mockRevokeLink.mockResolvedValue({ id: LINK_ID, relationshipId: REL_ID });
  });

  const baseInput = { requestId: REQUEST_ID, relationshipId: REL_ID, linkId: LINK_ID };

  it('rejects the expert lens with forbidden', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert' });
    expect(await revokeProposalShareLink(baseInput)).toEqual({ ok: false, error: 'forbidden' });
    expect(mockRevokeLink).not.toHaveBeenCalled();
  });

  it('revokes, tracks, and returns ok', async () => {
    const result = await revokeProposalShareLink(baseInput);
    expect(result).toEqual({ ok: true });
    expect(mockRevokeLink).toHaveBeenCalledWith({ id: LINK_ID, actorUserId: USER_ID });
    expect(mockTrack).toHaveBeenCalledWith('project_proposal_share_revoked', {
      share_link_id: LINK_ID,
      distinct_id: USER_ID,
    });
  });

  it('never revokes a link that is not on the presented relationship (cross-relationship guard)', async () => {
    mockListActive.mockResolvedValue([]); // linkId belongs to a different relationship
    expect(await revokeProposalShareLink(baseInput)).toEqual({ ok: false, error: 'not_found' });
    expect(mockRevokeLink).not.toHaveBeenCalled();
  });

  it('returns not_found when the revoke conditional update finds nothing', async () => {
    mockRevokeLink.mockResolvedValue(undefined);
    expect(await revokeProposalShareLink(baseInput)).toEqual({ ok: false, error: 'not_found' });
  });
});
