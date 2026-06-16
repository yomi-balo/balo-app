import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

// `rich-text.tsx` (reached through the real shell) imports `server-only`.
vi.mock('server-only', () => ({}));

// ── Seams the page composes (mirrors the BAL-247/251 RSC page-test precedent) ──
const {
  mockFindByIdWithRelations,
  mockGetCurrentUser,
  mockNotFound,
  mockRedirect,
  mockLogWarn,
  mockLogError,
  mockTrackServerAndFlush,
} = vi.hoisted(() => ({
  mockFindByIdWithRelations: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  // notFound()/redirect() must THROW so control flow stops, exactly like Next.
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectRequestsRepository: { findByIdWithRelations: mockFindByIdWithRelations },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/logging', () => ({ log: { warn: mockLogWarn, error: mockLogError } }));
// Server analytics seam (BAL-276): the denial boundary emits the
// project_request_access_denied event ONLY for a declined expert. The seam wraps
// trackServer + a next/server after() flush — the page only knows trackServerAndFlush.
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: mockTrackServerAndFlush,
  PROJECT_SERVER_EVENTS: { REQUEST_ACCESS_DENIED: 'project_request_access_denied' },
}));

// Phase-2 conversation loader (BAL-271) — its own unit tests cover the real
// implementation; here we only assert WHEN the page calls it.
const mockLoadConversationView = vi.hoisted(() => vi.fn());
vi.mock('@/lib/project-request/conversation-view', () => ({
  loadConversationView: (...args: unknown[]) => mockLoadConversationView(...args),
}));

// useIsMobile (inside the conversation island) reads window.matchMedia.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import RequestDetailPage, { generateMetadata } from './page';

const REQUEST_ID = 'req-1';
const COMPANY_ID = 'company-1';
const OTHER_COMPANY_ID = 'company-2';
const EXPERT_PROFILE_ID = 'expert-1';
const CONTACT_NAME = 'Dana Whitfield';
const REQUEST_TITLE = 'CPQ implementation';

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    expertProfileId: null,
    createdByUserId: 'user-client',
    sendTo: 'match',
    status: 'requested',
    source: 'manual',
    title: REQUEST_TITLE,
    description: '<p>Brief</p>',
    budgetMinCents: null,
    budgetMaxCents: null,
    budgetCurrency: 'aud',
    timeline: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    createdByUser: {
      id: 'user-client',
      firstName: 'Dana',
      lastName: 'Whitfield',
      email: 'dana@northwind.test',
    },
    tags: [],
    products: [],
    documents: [],
    relationships: [],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: COMPANY_ID,
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

function liveRelationship(): ProjectRequestWithRelations['relationships'][number] {
  return {
    id: 'rel-1',
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'invited',
    invitedAt: new Date('2025-01-01T00:00:00Z'),
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
  } as ProjectRequestWithRelations['relationships'][number];
}

// A declined relationship stays live at the DB layer but grants no access — the
// expert resolves to NO lens and the denial boundary fires the BAL-276 event.
function declinedRelationship(): ProjectRequestWithRelations['relationships'][number] {
  return { ...liveRelationship(), status: 'declined' };
}

async function renderPage(requestId = REQUEST_ID) {
  const ui = await RequestDetailPage({ params: Promise.resolve({ requestId }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConversationView.mockResolvedValue({
    viewerUserId: 'user-x',
    threads: [],
    defaultThreadId: null,
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
  });
});

describe('RequestDetailPage (RSC) — auth + lens gating', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('calls notFound() when the request is missing (undefined)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and notFound()s for an authenticated stranger (no leak)', async () => {
    // Different company, no invite, not admin → resolver returns null.
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindByIdWithRelations.mockResolvedValue(request());

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Project request access denied',
      expect.objectContaining({ requestId: REQUEST_ID, reason: 'not_a_participant' })
    );
    // A plain stranger is not a declined expert → no analytics event.
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    // The contact name must never reach the rendered tree for a stranger.
    expect(screen.queryByText(CONTACT_NAME)).not.toBeInTheDocument();
  });

  it('emits project_request_access_denied for a DECLINED expert (BAL-276) and notFound()s', async () => {
    // A dropped/declined expert hitting the wall — distinct from a plain stranger.
    const expertUser = user({
      id: 'user-declined-expert',
      companyId: OTHER_COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      activeMode: 'expert',
    });
    mockGetCurrentUser.mockResolvedValue(expertUser);
    mockFindByIdWithRelations.mockResolvedValue(
      request({ status: 'proposal_submitted', relationships: [declinedRelationship()] })
    );

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('project_request_access_denied', {
      request_id: REQUEST_ID,
      reason: 'declined_relationship',
      lens_attempted: 'expert',
      distinct_id: 'user-declined-expert',
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Project request access denied',
      expect.objectContaining({ requestId: REQUEST_ID, reason: 'declined_relationship' })
    );
  });

  it('never emits the denial event for an authorised viewer (client owner)', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockResolvedValue(request());

    await renderPage();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('logs an error and rethrows (to error.tsx) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockRejectedValue(new Error('db down'));

    await expect(renderPage()).rejects.toThrow('db down');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load project request detail',
      expect.objectContaining({ requestId: REQUEST_ID })
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});

describe('RequestDetailPage (RSC) — authorised lenses render the shell', () => {
  it('renders the client view (owner) with the request title', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockResolvedValue(request());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(REQUEST_TITLE, 'i') })
    ).toBeInTheDocument();
    expect(screen.getByText('Client')).toBeInTheDocument();
    // Client never sees their own identity as a "Contact".
    expect(screen.queryByText(CONTACT_NAME)).not.toBeInTheDocument();
  });

  it('renders the expert view for an invited expert (live relationship)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({
        companyId: OTHER_COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        activeMode: 'expert',
      })
    );
    mockFindByIdWithRelations.mockResolvedValue(
      request({ status: 'experts_invited', relationships: [liveRelationship()] })
    );

    await renderPage();
    expect(screen.getByText('Expert')).toBeInTheDocument();
    // Expert lens sees the named contact.
    expect(screen.getByText(CONTACT_NAME)).toBeInTheDocument();
  });

  it('renders the admin observer view', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindByIdWithRelations.mockResolvedValue(request({ status: 'eoi_submitted' }));

    await renderPage();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });
});

describe('RequestDetailPage (RSC) — Phase-2 conversation payload (BAL-271)', () => {
  it('loads the conversation for a Phase-2 participant', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockResolvedValue(request({ status: 'eoi_submitted' }));

    await renderPage();
    expect(mockLoadConversationView).toHaveBeenCalledTimes(1);
    // Zero-thread payload → invitation empty state, never a blank panel.
    expect(screen.getByText(/Your conversation lives here/i)).toBeInTheDocument();
  });

  it('never loads the conversation in Phase 1', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockResolvedValue(request({ status: 'requested' }));

    await renderPage();
    expect(mockLoadConversationView).not.toHaveBeenCalled();
  });

  it('never loads the conversation for the admin observer (even at Phase 2)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindByIdWithRelations.mockResolvedValue(request({ status: 'eoi_submitted' }));

    await renderPage();
    expect(mockLoadConversationView).not.toHaveBeenCalled();
  });
});

describe('RequestDetailPage — generateMetadata (Fix 1: no existence/title leak)', () => {
  async function meta(requestId = REQUEST_ID) {
    return generateMetadata({ params: Promise.resolve({ requestId }) });
  }

  it('returns the GENERIC title for a null user (never echoes the title)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await meta();
    expect(result.title).toBe('Project request — Balo');
    expect(result.robots).toMatchObject({ index: false, follow: false });
    // Must not have loaded the request to derive a title.
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('returns the GENERIC title for an authenticated stranger (existence not confirmed)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindByIdWithRelations.mockResolvedValue(request());

    const result = await meta();
    // The real title must NOT appear — a non-participant can't distinguish
    // doesn't-exist from exists-but-not-yours.
    expect(result.title).toBe('Project request — Balo');
    expect(result.title).not.toContain(REQUEST_TITLE);
  });

  it('returns the GENERIC title when the request is missing', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    expect((await meta()).title).toBe('Project request — Balo');
  });

  it('returns the REAL title only for an authorised participant', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockResolvedValue(request());

    const result = await meta();
    expect(result.title).toBe(`${REQUEST_TITLE} — Balo`);
    expect(result.robots).toMatchObject({ index: false, follow: false });
  });

  it('falls back to the GENERIC title (leak-free) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindByIdWithRelations.mockRejectedValue(new Error('db down'));
    expect((await meta()).title).toBe('Project request — Balo');
  });
});
