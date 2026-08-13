import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { log } from '@/lib/logging';
import type {
  CaseConsultationRowView,
  CaseConversationView,
  CaseHeaderView,
  CaseSurfaceView,
} from '@/lib/cases/case-view-types';

const ENGAGEMENT_ID = 'c0000000-0000-4000-8000-000000000001';
const USER_ID = 'd0000000-0000-4000-8000-000000000002';
const CASE_TITLE = 'Flow interview stuck on a record-triggered loop';

vi.mock('server-only', () => ({}));

// ⚠ `notFound()` and `redirect()` THROW in Next. Mocking them as throwing sentinels is what
// makes the control flow genuinely pinned: a page that called `notFound()` and then carried on
// rendering would pass a mock that merely recorded the call.
const notFoundError = new Error('NEXT_NOT_FOUND');
const redirectError = new Error('NEXT_REDIRECT');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
  redirect: (...a: unknown[]) => {
    mockRedirect(...a);
    throw redirectError;
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const mockRedirect = vi.fn();

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockLoadCase = vi.fn();
vi.mock('./_lib/load-case', () => ({
  loadCase: (...a: unknown[]) => mockLoadCase(...a),
}));

const mockTrack = vi.fn();
// ⚠ THE EVENT CONSTANTS COME FROM SOURCE, NOT A HAND-RESTATED LITERAL — the `page.test.tsx`
// precedent next door. A rename in `packages/analytics/src/events/recap.ts` must fail HERE
// rather than leave a green suite asserting an event name nothing emits.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

// The surface itself is a large client tree with its own suites; here it is a witness that the
// page reached the render, and a record of exactly which view object it was handed.
const mockCaseSurface = vi.fn();
vi.mock('./_components/case-surface', () => ({
  CaseSurface: (props: Readonly<{ view: CaseSurfaceView }>) => {
    mockCaseSurface(props.view);
    return <div data-testid="case-surface">{props.view.header.title}</div>;
  },
}));

import CasePage, { generateMetadata } from './page';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

const OPEN_HEADER: CaseHeaderView = {
  title: CASE_TITLE,
  descriptionHtml: '<p>The record-triggered flow fires twice on update.</p>',
  openedAtIso: '2026-07-01T00:00:00.000Z',
  heldConsultationCount: 2,
  consultationCount: 3,
  isOpen: true,
  closeReason: null,
  closedAtIso: null,
  counterpartyOrgLabel: 'CloudPeak',
  closedNote: null,
};

function consultation(n: number): CaseConsultationRowView {
  return {
    meetingId: 'm0000000-0000-4000-8000-00000000000' + String(n),
    ordinal: n,
    state: 'held',
    scheduledStartIso: '2026-07-0' + String(n) + 'T04:00:00.000Z',
    startedAtIso: '2026-07-0' + String(n) + 'T04:01:00.000Z',
    durationMinutes: 30,
    recapHref: null,
    actionItemCount: 0,
    fileCount: 0,
    hasTranscript: false,
    hasRecording: false,
  };
}

// ⚠ THREE — non-zero AND non-one, so `consultation_count` cannot pass by coinciding with a
// length-of-empty or an off-by-one.
const CONSULTATIONS: CaseConsultationRowView[] = [
  consultation(1),
  consultation(2),
  consultation(3),
];

const CONVERSATION: CaseConversationView = {
  conversationId: 'v0000000-0000-4000-8000-000000000003',
  writable: true,
  counterpartyFirstName: 'Amara',
  counterpartyName: 'Amara Okafor',
  initialMessages: [],
  initialHasEarlier: false,
  initialFiles: [],
  realtimeEnabled: false,
};

const BASE = {
  engagementId: ENGAGEMENT_ID,
  viewerUserId: USER_ID,
  header: OPEN_HEADER,
  nudge: null,
  consultations: CONSULTATIONS,
  conversation: CONVERSATION,
  actionItems: {
    yours: [],
    theirs: [],
    unassigned: [],
    counterpartyLabel: 'Amara',
    doneCount: 0,
    totalCount: 0,
  },
  files: [],
  filesTruncated: false,
  party: {
    name: 'Amara Okafor',
    headline: 'Salesforce CPQ specialist',
    orgLabel: 'CloudPeak',
    avatarUrl: null,
    initials: 'AO',
    bookAgainHref: '/experts/amara',
  },
  people: [
    { name: 'Dana Reyes', isViewer: true },
    { name: 'Amara Okafor', isViewer: false },
  ],
};

const CLIENT_VIEW: CaseSurfaceView = { ...BASE, lens: 'client', canClose: true };

const EXPERT_VIEW: CaseSurfaceView = {
  ...BASE,
  lens: 'expert',
  earnings: { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 },
  canRequestResolution: false,
};

/** A CLOSED client view, with the close reason under test. */
function closedView(closeReason: CaseHeaderView['closeReason']): CaseSurfaceView {
  return {
    ...CLIENT_VIEW,
    header: {
      ...OPEN_HEADER,
      isOpen: false,
      closeReason,
      closedAtIso: '2026-08-01T00:00:00.000Z',
      closedNote: 'Everything here stays available.',
    },
  };
}

/** ⚠ `params` IS A REAL PROMISE — Next 16 hands the page one, and the page must await it. */
function props(engagementId: string = ENGAGEMENT_ID): Readonly<{
  params: Promise<{ engagementId: string }>;
}> {
  return { params: Promise.resolve({ engagementId }) };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────

describe('CasePage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadCase.mockResolvedValue(CLIENT_VIEW);
  });

  it('redirects to /login when there is no session, and never reaches the loader', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(CasePage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockLoadCase).not.toHaveBeenCalled();
    expect(mockCaseSurface).not.toHaveBeenCalled();
  });

  it('404s on a null load and does NOT render the surface — one copy for every denial', async () => {
    mockLoadCase.mockResolvedValue(null);
    await expect(CasePage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockCaseSurface).not.toHaveBeenCalled();
  });

  it('AWAITS the params promise (Next 16) rather than reading it as an object', async () => {
    await CasePage(props());

    expect(mockLoadCase).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);

    // The `toHaveBeenCalledWith` above already fails on a Promise or an `undefined` id; this
    // spells out WHY, so a regression reads as "the id was not a string" rather than a diff.
    const [call] = mockLoadCase.mock.calls;
    if (call === undefined) throw new Error('loadCase was never called');
    const [firstArg, secondArg] = call;
    expect(typeof firstArg).toBe('string');
    expect(firstArg).toBe(ENGAGEMENT_ID);
    expect(secondArg).toBe(USER_ID);
  });

  it('passes the id from THIS request, not a cached one', async () => {
    const other = 'c0000000-0000-4000-8000-00000000beef';
    await CasePage(props(other));
    expect(mockLoadCase).toHaveBeenCalledWith(other, USER_ID);
  });

  it('renders the surface with the loaded view on the authorised path', async () => {
    const element = await CasePage(props());
    render(element);
    expect(screen.getByTestId('case-surface')).toHaveTextContent(CASE_TITLE);
    expect(mockCaseSurface).toHaveBeenCalledWith(CLIENT_VIEW);
  });
});

describe('CasePage — a loader failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
  });

  it('LOGS the failure and RE-THROWS so error.tsx renders the boundary', async () => {
    mockLoadCase.mockRejectedValue(new Error('pg: connection reset'));

    await expect(CasePage(props())).rejects.toThrow(/pg: connection reset/);

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'Failed to load case surface',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        error: 'pg: connection reset',
      })
    );
  });

  it('logs a NON-Error rejection too, with no fabricated stack', async () => {
    mockLoadCase.mockRejectedValue('pg: connection reset');

    await expect(CasePage(props())).rejects.toBe('pg: connection reset');

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'Failed to load case surface',
      expect.objectContaining({ error: 'pg: connection reset', stack: undefined })
    );
  });

  it('fires NO view event when the load failed', async () => {
    mockLoadCase.mockRejectedValue(new Error('boom'));
    await expect(CasePage(props())).rejects.toThrow(/boom/);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('CasePage — the view event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadCase.mockResolvedValue(CLIENT_VIEW);
  });

  it('fires case_surface_viewed with the full dimension set on the client lens', async () => {
    await CasePage(props());
    expect(mockTrack).toHaveBeenCalledWith('case_surface_viewed', {
      lens: 'client',
      consultation_count: 3,
      case_state: 'open',
      distinct_id: USER_ID,
    });
  });

  it('reports the EXPERT lens on the expert arm', async () => {
    mockLoadCase.mockResolvedValue(EXPERT_VIEW);
    await CasePage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'case_surface_viewed',
      expect.objectContaining({ lens: 'expert' })
    );
  });

  it('counts consultations from the view, not from the header', async () => {
    mockLoadCase.mockResolvedValue({
      ...CLIENT_VIEW,
      // The header's own counter deliberately disagrees: the dimension must read the LIST.
      header: { ...OPEN_HEADER, consultationCount: 99 },
      consultations: [consultation(1), consultation(2)],
    });
    await CasePage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'case_surface_viewed',
      expect.objectContaining({ consultation_count: 2 })
    );
  });

  it('does NOT fire on the notFound path — a denied viewer registers no view', async () => {
    mockLoadCase.mockResolvedValue(null);
    await expect(CasePage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('does NOT fire on the redirect path — an anonymous viewer registers no view', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(CasePage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('CasePage — case_state keeps the two closed reasons distinct', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
  });

  async function caseStateFor(view: CaseSurfaceView): Promise<unknown> {
    mockLoadCase.mockResolvedValue(view);
    await CasePage(props());
    const [call] = mockTrack.mock.calls;
    if (call === undefined) throw new Error('the view event never fired');
    const [, payload] = call;
    return (payload as Record<string, unknown>).case_state;
  }

  it('an OPEN case reports open', async () => {
    expect(await caseStateFor(CLIENT_VIEW)).toBe('open');
  });

  it('a case closed by the 30-day sweep reports auto_inactive', async () => {
    expect(await caseStateFor(closedView('auto_inactive'))).toBe('auto_inactive');
  });

  it('a deliberately closed case reports resolved — NOT collapsed into auto_inactive', async () => {
    expect(await caseStateFor(closedView('resolved'))).toBe('resolved');
  });

  it('a closed case with NO recorded reason still reports resolved', async () => {
    expect(await caseStateFor(closedView(null))).toBe('resolved');
  });
});

describe('generateMetadata — the anti-oracle contract', () => {
  const GENERIC_TITLE = 'Case — Balo';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadCase.mockResolvedValue(CLIENT_VIEW);
  });

  it('specialises the title only for an authorised viewer, and never indexes', async () => {
    const meta = await generateMetadata(props());
    expect(meta.title).toBe(CASE_TITLE + ' — Balo');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('falls back to the generic title when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe(GENERIC_TITLE);
    expect(String(meta.title)).not.toContain(CASE_TITLE);
    expect(mockLoadCase).not.toHaveBeenCalled();
  });

  it('falls back to the generic title on a gate denial — it never echoes the subject', async () => {
    mockLoadCase.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe(GENERIC_TITLE);
    expect(String(meta.title)).not.toContain(CASE_TITLE);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('falls back to the generic title when the loader throws, rather than surfacing the error', async () => {
    mockLoadCase.mockRejectedValue(new Error('boom'));
    const meta = await generateMetadata(props());
    expect(meta.title).toBe(GENERIC_TITLE);
    expect(String(meta.title)).not.toContain(CASE_TITLE);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('AWAITS params here too, and runs the full gate before specialising', async () => {
    await generateMetadata(props());
    expect(mockLoadCase).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });
});
