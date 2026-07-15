import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { render, screen } from '@/test/utils';

const TOKEN = 'testtoken-abc';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const LINK_ID = 'd0000000-0000-4000-8000-000000000004';

const mockFindLive = vi.fn();
const mockRecordAccess = vi.fn();
const mockFindProposal = vi.fn();
const mockFindRelationship = vi.fn();
const mockFindRequest = vi.fn();
const mockFindDomain = vi.fn();
const mockFindUser = vi.fn();
const mockOrgName = vi.fn();

vi.mock('@balo/db', () => ({
  proposalShareLinksRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindLive(...a),
    recordAccess: (...a: unknown[]) => mockRecordAccess(...a),
  },
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindProposal(...a),
    findExpertOrgName: (...a: unknown[]) => mockOrgName(...a),
  },
  requestExpertRelationshipsRepository: {
    findById: (...a: unknown[]) => mockFindRelationship(...a),
  },
  projectRequestsRepository: { findByIdWithRelations: (...a: unknown[]) => mockFindRequest(...a) },
  partyDomainsRepository: { findActiveByDomain: (...a: unknown[]) => mockFindDomain(...a) },
  usersRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  proposalMilestonesRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalPaymentInstallmentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalDocumentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
}));

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

vi.mock('@/lib/project-request/proposal-audience-view', () => ({
  hydrateReviewDoc: () => ({ id: PROPOSAL_ID, version: 3 }),
}));

vi.mock('@/components/balo/project-request/proposal/proposal-doc', () => ({
  ProposalDoc: () => <div data-testid="proposal-doc" />,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    PROJECT_SERVER_EVENTS: events.PROJECT_SERVER_EVENTS,
  };
});

import SharedProposalPage from './page';

function makeParams(token = TOKEN): { params: Promise<{ token: string }> } {
  // params is a PROMISE (Next 16) — the page MUST await it.
  return { params: Promise.resolve({ token }) };
}

function primeHappyPath(
  overrides: { status?: string; accessCount?: number; acceptedAt?: Date | null } = {}
): void {
  mockCheckLimit.mockReturnValue(true);
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  mockFindLive.mockResolvedValue({
    id: LINK_ID,
    relationshipId: REL_ID,
    createdByUserId: USER_ID,
    recipientEmail: 'alex@northwind.com',
    tokenHash: TOKEN_HASH,
    accessCount: overrides.accessCount ?? 0,
    expiresAt: new Date('2026-08-13T00:00:00Z'),
  });
  mockRecordAccess.mockResolvedValue(undefined);
  mockFindProposal.mockResolvedValue({
    id: PROPOSAL_ID,
    status: overrides.status ?? 'submitted',
    version: 3,
    acceptedAt: overrides.acceptedAt ?? null,
  });
  mockFindRelationship.mockResolvedValue({ id: REL_ID, projectRequestId: REQUEST_ID });
  mockFindRequest.mockResolvedValue({
    id: REQUEST_ID,
    title: 'Salesforce CPQ',
    companyId: 'company-1',
    company: { id: 'company-1', name: 'Acme Industrial' },
    relationships: [{ id: REL_ID }],
  });
  mockFindUser.mockResolvedValue({ firstName: 'Dana', lastName: 'Okafor', email: 'dana@acme.com' });
  mockOrgName.mockResolvedValue('Meridian Consulting');
  mockFindDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
}

async function renderPage(params = makeParams()): Promise<void> {
  render(await SharedProposalPage(params));
}

describe('SharedProposalPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the active proposal with provenance, doc, Join CTA, and footer', async () => {
    primeHappyPath();
    await renderPage();

    expect(
      screen.getByText('Shared with you by Dana Okafor at Acme Industrial')
    ).toBeInTheDocument();
    expect(screen.getByTestId('proposal-doc')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join Acme Industrial on Balo' })).toBeInTheDocument();
    expect(screen.getByText(/This link works until 13 August 2026/)).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith('project_proposal_share_opened', {
      share_link_id: LINK_ID,
      first_open: true,
      distinct_id: `share_${LINK_ID}`,
    });
    // Access is stamped once the proposal is confirmed renderable.
    expect(mockRecordAccess).toHaveBeenCalledWith(LINK_ID);
  });

  it('shows the accepted banner', async () => {
    primeHappyPath({ status: 'accepted', acceptedAt: new Date('2026-07-12T00:00:00Z') });
    await renderPage();
    expect(
      screen.getByText('This proposal was accepted by Acme Industrial on 12 July 2026.')
    ).toBeInTheDocument();
  });

  it('shows the withdrawn banner (expert org) and suppresses the Join CTA', async () => {
    primeHappyPath({ status: 'withdrawn' });
    await renderPage();
    expect(screen.getByText(/withdrawn by Meridian Consulting/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Join/ })).not.toBeInTheDocument();
  });

  it('falls back to a neutral expert-side label (never the client company) when the expert org is null', async () => {
    primeHappyPath({ status: 'withdrawn' });
    mockOrgName.mockResolvedValue(null);
    await renderPage();
    expect(screen.getByText(/withdrawn by the expert/)).toBeInTheDocument();
    expect(screen.queryByText(/withdrawn by Acme Industrial/)).not.toBeInTheDocument();
  });

  it('hides the Join CTA when the recipient domain does not match the client company', async () => {
    primeHappyPath();
    mockFindDomain.mockResolvedValue({ partyType: 'company', partyId: 'someone-else' });
    await renderPage();
    expect(screen.queryByRole('link', { name: /Join/ })).not.toBeInTheDocument();
  });

  it('records first_open=false when the link was already opened', async () => {
    primeHappyPath({ accessCount: 4 });
    await renderPage();
    expect(mockTrack).toHaveBeenCalledWith(
      'project_proposal_share_opened',
      expect.objectContaining({ first_open: false })
    );
  });

  it('renders the generic inactive card on a token miss (no leak)', async () => {
    primeHappyPath();
    mockFindLive.mockResolvedValue(undefined);
    await renderPage();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-doc')).not.toBeInTheDocument();
  });

  it('renders the inactive card on a token-hash mismatch', async () => {
    primeHappyPath();
    mockFindLive.mockResolvedValue({
      id: LINK_ID,
      relationshipId: REL_ID,
      createdByUserId: USER_ID,
      recipientEmail: 'alex@northwind.com',
      tokenHash: createHash('sha256').update('different').digest('hex'),
      accessCount: 0,
      expiresAt: new Date('2026-08-13T00:00:00Z'),
    });
    await renderPage();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
  });

  it('renders the inactive card for a draft/no-current proposal', async () => {
    primeHappyPath({ status: 'draft' });
    await renderPage();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    // A non-renderable proposal must NOT stamp access or consume first-open — the
    // access is stamped only after the renderability guard (BAL-386 S3).
    expect(mockRecordAccess).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('does NOT stamp access or emit the opened event when a post-guard lookup is anomalous', async () => {
    // The proposal is renderable, but a data anomaly makes the relationship lookup
    // return undefined → LinkNotActive. Access must NOT be stamped and the opened
    // event must NOT fire, so a later real open still reports first_open truthfully.
    primeHappyPath();
    mockFindRelationship.mockResolvedValue(undefined);
    await renderPage();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockRecordAccess).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('rate-limits to the inactive card WITHOUT looking up the token', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);
    await renderPage();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockFindLive).not.toHaveBeenCalled();
  });
});
