import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type {
  ClientEndOfCallView,
  ExpertEndOfCallView,
} from '@/lib/meetings/end-of-call-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

// Motion misbehaves under JSDOM. The SHARED stub memoises per tag, so the reveal cascade does
// not remount the card's subtree on every render — see `@/test/motion-stub`.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const notFoundError = new Error('NEXT_NOT_FOUND');
const redirectError = new Error('NEXT_REDIRECT');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
  redirect: () => {
    throw redirectError;
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockLoad = vi.fn();
vi.mock('./_lib/load-end-of-call', () => ({
  loadEndOfCall: (...a: unknown[]) => mockLoad(...a),
}));

const mockTrack = vi.fn();
// ⚠ THE CONSTANTS COME FROM SOURCE, NOT A HAND-RESTATED LITERAL. `apps/web/src/test/setup.ts`
// is CLIENT-only, so a server event needs its own local mock here — and sourcing the constant
// means a rename in `packages/analytics` fails HERE rather than leaving a green suite asserting
// an event name nothing emits.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    END_OF_CALL_SERVER_EVENTS: events.END_OF_CALL_SERVER_EVENTS,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: vi.fn(),
}));
vi.mock('../_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));

import EndOfCallPage, { metadata } from './page';

const BASE = {
  meetingId: MEETING_ID,
  contextType: 'case' as const,
  isCase: true,
  durationMinutes: 45,
  recapState: 'processing' as const,
  meetingHeld: true,
  caseHref: '/cases/' + ENGAGEMENT_ID,
};

const CLIENT_VIEW: ClientEndOfCallView = {
  ...BASE,
  counterpartyName: 'Amara',
  lens: 'client',
  rating: { engagementId: ENGAGEMENT_ID, state: { kind: 'none' }, existingBody: null },
  resolve: {
    engagementId: ENGAGEMENT_ID,
    requesterLabel: null,
    alreadyClosed: false,
    expertShortName: 'Amara',
  },
};

const EXPERT_VIEW: ExpertEndOfCallView = {
  ...BASE,
  counterpartyName: 'Northwind Industrial',
  lens: 'expert',
};

function props(over: Record<string, unknown> = {}) {
  return { params: Promise.resolve({ meetingId: MEETING_ID }), ...over };
}

describe('EndOfCallPage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoad.mockResolvedValue(CLIENT_VIEW);
  });

  it('redirects to login when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(EndOfCallPage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('404s on every gate denial, with no existence oracle', async () => {
    mockLoad.mockResolvedValue(null);
    await expect(EndOfCallPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('AWAITS the params promise (Next 16) rather than reading it as an object', async () => {
    await EndOfCallPage(props());
    expect(mockLoad).toHaveBeenCalledWith(MEETING_ID, USER_ID);
  });

  it('re-throws a loader failure so error.tsx renders the boundary', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    await expect(EndOfCallPage(props())).rejects.toThrow(/boom/);
  });
});

describe('EndOfCallPage — metadata', () => {
  it('is STATIC, neutral and never indexed', () => {
    // ⚠ It names no subject, so there is nothing to authorise and nothing to leak — which is why
    // this screen needs no `generateMetadata`. "Meeting", not "Consultation": the tab title must
    // not disclose that the meeting is a case.
    expect(metadata.title).toBe('Meeting complete — Balo');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(String(metadata.title)).not.toContain('Consultation');
  });
});

describe('EndOfCallPage — analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoad.mockResolvedValue(CLIENT_VIEW);
  });

  it('fires end_of_call_viewed on the authorised path, with every dimension', async () => {
    await EndOfCallPage(props());
    expect(mockTrack).toHaveBeenCalledWith('end_of_call_viewed', {
      recap_state: 'processing',
      rating_state: 'none',
      resolve_prompt_shown: false,
      context_type: 'case',
      lens: 'client',
      distinct_id: USER_ID,
    });
  });

  it('reports rating_state: null on the EXPERT lens — structurally absent, not hidden', async () => {
    mockLoad.mockResolvedValue(EXPERT_VIEW);
    await EndOfCallPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'end_of_call_viewed',
      expect.objectContaining({
        lens: 'expert',
        rating_state: null,
        resolve_prompt_shown: false,
      })
    );
  });

  it('reports resolve_prompt_shown at FIRST PAINT — true only with a rating already on file', async () => {
    mockLoad.mockResolvedValue({
      ...CLIENT_VIEW,
      rating: {
        engagementId: ENGAGEMENT_ID,
        state: { kind: 'rated_ok', rating: 5 },
        existingBody: null,
      },
    });
    await EndOfCallPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'end_of_call_viewed',
      expect.objectContaining({ rating_state: 'rated_ok', resolve_prompt_shown: true })
    );
  });

  it('reports resolve_prompt_shown: false once the case is already closed', async () => {
    mockLoad.mockResolvedValue({
      ...CLIENT_VIEW,
      rating: {
        engagementId: ENGAGEMENT_ID,
        state: { kind: 'rated_low', rating: 2 },
        existingBody: null,
      },
      resolve: { ...CLIENT_VIEW.resolve, alreadyClosed: true },
    });
    await EndOfCallPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'end_of_call_viewed',
      expect.objectContaining({ rating_state: 'rated_low', resolve_prompt_shown: false })
    );
  });

  it('reports rating_state: null for a client on a non-rateable context', async () => {
    mockLoad.mockResolvedValue({
      ...CLIENT_VIEW,
      contextType: 'request_interaction',
      isCase: false,
      rating: null,
      resolve: null,
    });
    await EndOfCallPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'end_of_call_viewed',
      expect.objectContaining({
        context_type: 'request_interaction',
        rating_state: null,
        resolve_prompt_shown: false,
      })
    );
  });
});

describe('EndOfCallPage — what actually renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
  });

  async function renderPage(view: ClientEndOfCallView | ExpertEndOfCallView) {
    mockLoad.mockResolvedValue(view);
    return render(await EndOfCallPage(props()));
  }

  it('selects the CLIENT composition by lens', async () => {
    await renderPage(CLIENT_VIEW);
    expect(screen.getByRole('heading', { name: 'Consultation complete' })).toBeInTheDocument();
    expect(screen.getByText('How was your consultation with Amara?')).toBeInTheDocument();
  });

  it('selects the EXPERT composition by lens, with NO rating and NO resolve action', async () => {
    await renderPage(EXPERT_VIEW);
    expect(screen.getByRole('heading', { name: 'Nice session' })).toBeInTheDocument();
    expect(screen.queryByText(/How was/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Is this issue resolved/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sorted/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Rated/ })).not.toBeInTheDocument();
  });

  it('renders NEITHER consequential control once the post-call guard has denied them', async () => {
    // ⚠ THE RENDER HALF OF THE BAL-389 SECURITY FIX, END-TO-END. The loader nulls BOTH `rating`
    // and `resolve` for a FUTURE or CANCELLED consultation (`meetingAllowsPostCallActions`), and
    // the client composition must then offer neither — ABSENT, not disabled. A `case` context is
    // used deliberately: it is the one that WOULD carry both, so this cannot pass vacuously.
    const { container } = await renderPage({ ...CLIENT_VIEW, rating: null, resolve: null });
    expect(screen.queryByText(/How was your consultation/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Rated/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Is this issue resolved/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sorted/i })).not.toBeInTheDocument();
    // The screen itself still renders — the guard removes the CONTROLS, never the route.
    expect(screen.getByRole('heading', { name: 'Consultation complete' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/resolved/i);
  });

  it('states NOTHING FALSE once the post-call guard has denied them, and still renders', async () => {
    // ⚠⚠ THE COPY HALF OF THE SAME FIX, END-TO-END. Withholding the controls left the card
    // asserting a completed consultation over a success tick and promising a receipt for a
    // meeting that has not happened. The route must STILL RENDER (owner decision) — no
    // `notFound()`, no redirect — so the fix is the copy, not the gate.
    const { container } = await renderPage({
      ...CLIENT_VIEW,
      meetingHeld: false,
      rating: null,
      resolve: null,
    });
    expect(screen.getByRole('heading', { name: 'Nothing to wrap up yet' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('receipt');
    expect(container.textContent).not.toMatch(/complete/i);
    // The onward action survives the denial — the card must still read complete with ONE action.
    // `CLIENT_VIEW` is a processing recap on a case, so that action is the "Back to the case" arm.
    expect(screen.getByRole('link', { name: /Back to the case/ })).toBeInTheDocument();
  });

  it('renders NO Rejoin affordance — the owner decision, and a routing fact', async () => {
    // Every arm dead-ends today: `/join/m/{id}` is the ANONYMOUS lobby, `joinAsMemberAction` has
    // no entry point by design, and both terminate at `MeetingCallSurface`'s "Connecting…".
    // BAL-435 adds the button, the destination and the analytics value together.
    const { container } = await renderPage(CLIENT_VIEW);
    expect(container.textContent).not.toMatch(/rejoin/i);
    expect(container.innerHTML).not.toContain('/join/m/');
  });

  it('renders ONE onward CTA on both lenses, tagged for the entry funnel when it is the recap arm', async () => {
    // ⚠ BOTH LENSES GET THE SAME DESTINATION. BAL-421's case surface is itself lens-aware, so
    // the expert's back link is exactly as live as the client's — `lens` is an analytics
    // dimension here, never a conditional.
    const client = await renderPage({ ...CLIENT_VIEW, recapState: 'ready' });
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/' + MEETING_ID + '?from=end_of_call'
    );
    client.unmount();

    const expert = await renderPage({ ...EXPERT_VIEW, recapState: 'ready' });
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/' + MEETING_ID + '?from=end_of_call'
    );
    expert.unmount();

    // …and the processing arm goes to the case on BOTH lenses, carrying no `?from`.
    const processing = await renderPage(CLIENT_VIEW);
    expect(screen.getByRole('link', { name: /Back to the case/ })).toHaveAttribute(
      'href',
      '/cases/' + ENGAGEMENT_ID
    );
    processing.unmount();

    await renderPage(EXPERT_VIEW);
    expect(screen.getByRole('link', { name: /Back to the case/ })).toHaveAttribute(
      'href',
      '/cases/' + ENGAGEMENT_ID
    );
  });
});
