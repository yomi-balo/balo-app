import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type {
  CaseConsultationRowView,
  CaseFileRowView,
  CaseSurfaceView,
} from '@/lib/cases/case-view-types';

// N8 — a shared, hoisted spy so tests can assert `router.refresh()` fired, which a fresh
// `vi.fn()` returned from inside the factory on every `useRouter()` call could not do.
const { mockRouterRefresh } = vi.hoisted(() => ({ mockRouterRefresh: vi.fn() }));

/**
 * BAL-421 — the desktop composition, tested for the ONE thing composition can get wrong: which
 * lens is offered which lifecycle action.
 *
 * ⚠⚠ "MARK RESOLVED" IS CLIENT-ONLY (BAL-417), AND THE EXPERT MAY ONLY *ASK*. The asymmetry is
 * enforced three times over — the `CaseSurfaceView` DISCRIMINANT (an expert-lens view has no
 * `canClose` field at all), `resolveCaseAction`'s lens assertion, and
 * `caseEngagementsRepository.close()`'s live-membership invariant. This file pins the FIRST of
 * those at the render layer: the assertions below scan the WHOLE tree for the affordance rather
 * than checking one branch, so a future refactor that reintroduced a lens-blind `&&` would fail
 * here even if it read the flag from somewhere else.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'u0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));

vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => (
      <div className={props.className as string}>{props.children as React.ReactNode}</div>
    ),
  },
  useReducedMotion: () => true,
  AnimatePresence: (props: Record<string, unknown>) => <>{props.children as React.ReactNode}</>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh, push: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// N8/N14(c) — a minimal stand-in for the real dialog (which itself fetches availability and
// posts a Server Action — out of scope for a composition test). Exposes just enough surface to
// prove the CTA→dialog SEAM: it mounts only when `open`, and its three callback props are wired.
vi.mock('@/components/booking/reschedule-dialog', () => ({
  RescheduleDialog: (props: {
    open: boolean;
    onClose: () => void;
    onRescheduled: () => void;
    onTerminalFailure?: () => void;
    meetingId: string;
  }) =>
    props.open ? (
      <div data-testid="reschedule-dialog-stub">
        <span>meeting: {props.meetingId}</span>
        <button type="button" onClick={props.onClose}>
          Stub close
        </button>
        <button type="button" onClick={props.onRescheduled}>
          Stub rescheduled
        </button>
        <button type="button" onClick={props.onTerminalFailure}>
          Stub terminal failure
        </button>
      </div>
    ) : null,
}));

// BAL-411 — a minimal stand-in for `ProposeTimesDialog`, the SAME reason `RescheduleDialog` is
// stubbed: the real component calls `useIsMobile` (→ `window.matchMedia`, unavailable in jsdom)
// and fetches availability — out of scope for a composition test.
vi.mock('@/components/booking/propose-times-dialog', () => ({
  ProposeTimesDialog: (props: {
    open: boolean;
    onClose: () => void;
    onProposed: () => void;
    meetingId: string;
  }) =>
    props.open ? (
      <div data-testid="propose-times-dialog-stub">
        <span>meeting: {props.meetingId}</span>
        <button type="button" onClick={props.onClose}>
          Stub close
        </button>
        <button type="button" onClick={props.onProposed}>
          Stub proposed
        </button>
      </div>
    ) : null,
}));

// BAL-411 — `RescheduleProposalCard` fires Server Actions of its own; a minimal stand-in keeps
// this file a pure composition test the same way the two dialog stubs above do.
vi.mock('./reschedule-proposal-card', () => ({
  RescheduleProposalCard: (props: { lens: string; onChanged: () => void }) => (
    <div data-testid="reschedule-proposal-card-stub">
      <span>lens: {props.lens}</span>
      <button type="button" onClick={props.onChanged}>
        Stub changed
      </button>
    </div>
  ),
}));

vi.mock('@/components/balo/conversation/use-conversation-realtime', () => ({
  useConversationRealtime: vi.fn(),
}));

vi.mock('../_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));
vi.mock('../_actions/request-resolution', () => ({ requestResolutionAction: vi.fn() }));
vi.mock('../_actions/dismiss-resolution-request', () => ({
  dismissResolutionRequestAction: vi.fn(),
}));
vi.mock('../_actions/create-case-realtime-token', () => ({
  createCaseRealtimeTokenAction: vi.fn(),
}));
vi.mock('../_actions/fetch-case-thread', () => ({ fetchCaseThreadAction: vi.fn() }));
vi.mock('../_actions/post-case-message', () => ({ postCaseMessageAction: vi.fn() }));
vi.mock('../_actions/mark-case-thread-read', () => ({
  markCaseThreadReadAction: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../_actions/request-case-file-upload', () => ({ requestCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/confirm-case-file-upload', () => ({ confirmCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/get-case-file-download', () => ({ getCaseFileDownloadAction: vi.fn() }));

import { CaseSurface } from './case-surface';

const BASE = {
  engagementId: ENGAGEMENT_ID,
  expertProfileId: 'expert-1',
  viewerUserId: VIEWER_ID,
  header: {
    title: 'Flow interview loop',
    descriptionHtml: '<p>We need to rebuild the intake flow.</p>',
    openedAtIso: '2026-06-12T09:00:00Z',
    heldConsultationCount: 2,
    consultationCount: 3,
    isOpen: true,
    closeReason: null,
    closedAtIso: null,
    counterpartyOrgLabel: 'CloudPeak',
    closedNote: null,
  },
  nudge: null,
  consultations: [],
  conversation: {
    conversationId: 'v-1',
    writable: true,
    counterpartyFirstName: 'Amara',
    counterpartyName: 'Amara Okafor',
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
  },
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
    headline: 'Salesforce architect',
    orgLabel: 'CloudPeak',
    avatarUrl: null,
    initials: 'AO',
    bookAgainHref: '/experts/amara-okafor',
    ratingAverage: 4.3,
    ratingCount: 2,
  },
  people: [
    { name: 'Dana Reyes', isViewer: true },
    { name: 'Amara Okafor', isViewer: false },
  ],
} satisfies Omit<CaseSurfaceView, 'lens' | 'canClose'>;

function clientView(over: Record<string, unknown> = {}): CaseSurfaceView {
  return { ...BASE, lens: 'client', canClose: true, ...over } as CaseSurfaceView;
}

function expertView(over: Record<string, unknown> = {}): CaseSurfaceView {
  return {
    ...BASE,
    lens: 'expert',
    earnings: { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 },
    canRequestResolution: true,
    canProposeReschedule: true,
    canManageReschedule: true,
    ...over,
  } as CaseSurfaceView;
}

const MARK_RESOLVED = /mark resolved/i;
const ASK_RESOLVED = /ask if it's resolved/i;

const LENSES = ['client', 'expert'] as const;

/** Both lens arms of the same fixture, so a section-set assertion runs over each. */
function viewForLens(
  lens: (typeof LENSES)[number],
  over: Record<string, unknown> = {}
): CaseSurfaceView {
  return lens === 'client' ? clientView(over) : expertView(over);
}

const HELD_CONSULTATION: CaseConsultationRowView = {
  meetingId: 'm-1',
  ordinal: 1,
  state: 'held',
  scheduledStartIso: '2026-06-20T10:00:00Z',
  startedAtIso: '2026-06-20T10:01:00Z',
  durationMinutes: 42,
  recapHref: '/meetings/m-1?from=case_surface',
  actionItemCount: 2,
  fileCount: 1,
  hasTranscript: true,
  hasRecording: false,
};

const CASE_FILE: CaseFileRowView = {
  origin: 'meeting',
  id: 'mf-1',
  meetingId: 'm-1',
  fileName: 'intake-flow.pdf',
  contentType: 'application/pdf',
  sizeBytes: 12_800,
  createdAtIso: '2026-07-01T10:00:00Z',
  uploaderLabel: 'Amara',
  sourceLabel: 'Consultation 1',
};

const ACTION_ITEM: ActionItemNodeView = {
  id: 'ai-1',
  body: 'Send the sandbox credentials',
  status: 'open',
  assigneeParty: null,
  assigneeLabel: null,
  dueLabel: null,
  dueAtValue: null,
  isOverdue: false,
};

const CLOSED_HEADER = {
  ...BASE.header,
  isOpen: false,
  closeReason: 'resolved',
  closedAtIso: '2026-07-10T09:00:00Z',
  closedNote: 'This case was marked resolved on 10 Jul 2026.',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CaseSurface — the EXPERT lens NEVER renders "Mark resolved"', () => {
  it('offers the expert the ASK, and no close affordance anywhere in the tree', () => {
    const { container } = render(<CaseSurface view={expertView()} />);
    expect(screen.getByRole('button', { name: ASK_RESOLVED })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    // Belt and braces: the string does not appear at all, in any node or aria-label.
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });

  it('renders NO close affordance for the expert even when the ask is unavailable', () => {
    // The one state where the expert's own rail action is absent — the close must not appear
    // to fill the gap.
    const { container } = render(
      <CaseSurface view={expertView({ canRequestResolution: false })} />
    );
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });

  it('renders NO close affordance for the expert on a CLOSED case', () => {
    const view = expertView({
      header: { ...BASE.header, isOpen: false, closeReason: 'resolved' },
      canRequestResolution: false,
    });
    const { container } = render(<CaseSurface view={view} />);
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });
});

describe('CaseSurface — the CLIENT lens gets the close, and never the ask', () => {
  it('renders "Mark resolved" and NO "Ask if it\'s resolved"', () => {
    render(<CaseSurface view={clientView()} />);
    expect(screen.getByRole('button', { name: MARK_RESOLVED })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
  });

  /**
   * ⚠ BOTH FLAGS ARE FALSE ON A CLOSED CASE, so a resolved case offers NEITHER — and neither
   * is ever rendered DISABLED. An absent action beats a dead one.
   */
  it('renders NEITHER lifecycle action on a closed case', () => {
    const view = clientView({
      canClose: false,
      header: { ...BASE.header, isOpen: false, closeReason: 'resolved' },
    });
    render(<CaseSurface view={view} />);
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
  });

  it('never renders a DISABLED lifecycle button as a substitute for an absent one', () => {
    render(<CaseSurface view={clientView({ canClose: false })} />);
    const disabled = screen
      .queryAllByRole('button')
      .filter((button) => button.hasAttribute('disabled'));
    expect(disabled.map((button) => button.textContent ?? '').join(' ')).not.toMatch(MARK_RESOLVED);
  });
});

/**
 * ⚠⚠ FEE CONCEALMENT, AT THE RENDER LAYER. The earnings block is not conditionally HIDDEN on
 * the client arm — a client-lens view has no `earnings` FIELD to pass — so the invariant is
 * structural. This asserts the consequence: no money vocabulary reaches a client's DOM.
 */
describe('CaseSurface — the lens is a discriminant all the way down', () => {
  it('renders the earnings block ONLY on the expert arm', () => {
    const { unmount } = render(<CaseSurface view={expertView()} />);
    expect(screen.getByText('Earned on this case')).toBeInTheDocument();
    unmount();

    render(<CaseSurface view={clientView()} />);
    expect(screen.queryByText('Earned on this case')).not.toBeInTheDocument();
  });

  it('shows a CLIENT no earnings, no A$ figure and no margin vocabulary anywhere', () => {
    const { container } = render(<CaseSurface view={clientView()} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(container.textContent ?? '').not.toContain('A$');
    for (const word of ['earned', 'earnings', 'margin', 'markup', 'payout']) {
      expect(text).not.toContain(word);
    }
  });

  it('shows the EXPERT no A$ figure either while earnings are `not_yet`', () => {
    // Every case on `main` is in this state today — a figure here would be a money claim.
    const { container } = render(<CaseSurface view={expertView()} />);
    expect(container.textContent ?? '').not.toContain('A$');
  });

  it('renders the header and people for both lenses', () => {
    const { unmount } = render(<CaseSurface view={clientView()} />);
    expect(screen.getByRole('heading', { name: 'Flow interview loop' })).toBeInTheDocument();
    // "You" is resolved SERVER-SIDE via `isViewer`; the client never compares ids. The viewer's
    // own name must therefore NOT be rendered in the people list.
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Dana Reyes')).not.toBeInTheDocument();
    unmount();

    render(<CaseSurface view={expertView()} />);
    expect(screen.getByRole('heading', { name: 'Flow interview loop' })).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });
});

/**
 * ⚠ THE SECTION SET IS THE SAME ON BOTH ARMS. The mobile follow-up must be PURE COMPOSITION
 * over this SAME `CaseSurfaceView` (owner decision D1), which is only true while neither arm
 * gains or loses a region. A lens that quietly dropped the conversation or the files card would
 * pass every lens-specific test in this file and still break that contract.
 */
describe('CaseSurface — every section composes on both lens arms', () => {
  it.each(LENSES)('renders the whole section set on the %s lens', (lens) => {
    render(<CaseSurface view={viewForLens(lens)} />);
    for (const section of ['Conversation', 'Consultations', 'Action items', 'Files', 'People']) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument();
    }
    // The rail's counterparty card, which carries the one forward action.
    expect(screen.getByRole('link', { name: 'Book with Amara again' })).toBeInTheDocument();
  });

  it.each(LENSES)('passes the counterparty FIRST name down as the shared label, %s', (lens) => {
    render(
      <CaseSurface
        view={viewForLens(lens, {
          actionItems: { ...BASE.actionItems, yours: [ACTION_ITEM], totalCount: 1 },
        })}
      />
    );
    // `counterpartyFirstName` reaches the party card's CTA and the action-items heading alike.
    expect(screen.getByRole('link', { name: 'Book with Amara again' })).toBeInTheDocument();
    expect(screen.getByText('Yours')).toBeInTheDocument();
  });
});

describe('CaseSurface — the conditional regions', () => {
  it('renders NO nudge when the view carries none', () => {
    render(<CaseSurface view={clientView({ nudge: null })} />);
    expect(screen.queryByText(/Nothing booked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Next consultation/i)).not.toBeInTheDocument();
  });

  it('renders the ONE nudge the view chose, with its client-lens CTA', () => {
    render(<CaseSurface view={clientView({ nudge: { kind: 'nothing_booked' } })} />);
    expect(screen.getByText('Nothing booked yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book a consultation' })).toBeInTheDocument();
  });

  it('renders the resolution ask with both of the surface-owned actions wired', () => {
    render(<CaseSurface view={clientView({ nudge: { kind: 'resolution_ask' } })} />);
    expect(screen.getByRole('button', { name: 'Yes, mark it resolved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  // N8 — the reschedule CTA → dialog seam previously had ZERO coverage: `rescheduleOpen`,
  // `handleOpenReschedule`, `handleRescheduled` and the dialog's conditional mount never ran.
  describe('BAL-409 — reschedule CTA → dialog seam', () => {
    const UPCOMING_NUDGE = {
      kind: 'upcoming' as const,
      meetingId: 'm-upcoming-1',
      scheduledStartIso: '2026-09-01T10:00:00Z',
      live: false,
      durationMinutes: 45,
    };

    it('the dialog is NOT mounted while closed, even with an upcoming nudge', () => {
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);
      expect(screen.queryByTestId('reschedule-dialog-stub')).not.toBeInTheDocument();
    });

    it('is never mounted at all for a non-"upcoming" nudge (or none)', () => {
      render(<CaseSurface view={clientView({ nudge: { kind: 'nothing_booked' } })} />);
      expect(screen.queryByTestId('reschedule-dialog-stub')).not.toBeInTheDocument();
    });

    it('clicking "Reschedule" opens the dialog, mounted with the nudge’s meetingId', async () => {
      const user = userEvent.setup();
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);

      await user.click(screen.getByRole('button', { name: 'Reschedule' }));

      const stub = screen.getByTestId('reschedule-dialog-stub');
      expect(stub).toBeInTheDocument();
      expect(stub).toHaveTextContent('meeting: m-upcoming-1');
    });

    it('onClose closes the dialog WITHOUT refreshing the page', async () => {
      const user = userEvent.setup();
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);
      await user.click(screen.getByRole('button', { name: 'Reschedule' }));
      expect(screen.getByTestId('reschedule-dialog-stub')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Stub close' }));

      expect(screen.queryByTestId('reschedule-dialog-stub')).not.toBeInTheDocument();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('onRescheduled closes the dialog AND refreshes the page', async () => {
      const user = userEvent.setup();
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);
      await user.click(screen.getByRole('button', { name: 'Reschedule' }));

      await user.click(screen.getByRole('button', { name: 'Stub rescheduled' }));

      expect(screen.queryByTestId('reschedule-dialog-stub')).not.toBeInTheDocument();
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });

    // N14(c) — a TERMINAL dialog failure (meeting_not_reschedulable / meeting_not_found) must
    // ALSO close AND refresh, exactly like a successful reschedule — the CTA is stale either way.
    it('onTerminalFailure closes the dialog AND refreshes the page', async () => {
      const user = userEvent.setup();
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);
      await user.click(screen.getByRole('button', { name: 'Reschedule' }));

      await user.click(screen.getByRole('button', { name: 'Stub terminal failure' }));

      expect(screen.queryByTestId('reschedule-dialog-stub')).not.toBeInTheDocument();
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });

    it('offers no client "Reschedule" CTA on the EXPERT lens — it gets its OWN CTA (BAL-411)', () => {
      render(<CaseSurface view={expertView({ nudge: UPCOMING_NUDGE })} />);
      expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
    });
  });

  /** BAL-411 — the EXPERT's symmetrical propose-times dialog, same seam shape as BAL-409's. */
  describe('CaseSurface — the conditional regions › BAL-411 — propose-times CTA → dialog seam', () => {
    const UPCOMING_NUDGE = {
      kind: 'upcoming' as const,
      meetingId: 'm-upcoming-1',
      scheduledStartIso: '2026-09-01T10:00:00Z',
      live: false,
      durationMinutes: 45,
    };

    it('mounts the dialog only when the EXPERT has an upcoming meeting and canProposeReschedule', async () => {
      const user = userEvent.setup();
      render(
        <CaseSurface view={expertView({ nudge: UPCOMING_NUDGE, canProposeReschedule: true })} />
      );
      expect(screen.queryByTestId('propose-times-dialog-stub')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Propose a new time' }));

      const stub = screen.getByTestId('propose-times-dialog-stub');
      expect(stub).toBeInTheDocument();
      expect(stub).toHaveTextContent('meeting: m-upcoming-1');
    });

    it('offers no propose CTA on the CLIENT lens, even with an upcoming meeting', () => {
      render(<CaseSurface view={clientView({ nudge: UPCOMING_NUDGE })} />);
      expect(screen.queryByRole('button', { name: 'Propose a new time' })).not.toBeInTheDocument();
    });

    it('onProposed closes the dialog AND refreshes the page', async () => {
      const user = userEvent.setup();
      render(
        <CaseSurface view={expertView({ nudge: UPCOMING_NUDGE, canProposeReschedule: true })} />
      );
      await user.click(screen.getByRole('button', { name: 'Propose a new time' }));
      await user.click(screen.getByRole('button', { name: 'Stub proposed' }));
      expect(screen.queryByTestId('propose-times-dialog-stub')).not.toBeInTheDocument();
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });

  /** BAL-411 — the ONE place accept/decline/withdraw happen; mounted whenever the nudge is a
   *  live proposal, on EITHER lens. */
  describe('CaseSurface — the conditional regions › BAL-411 — the reschedule-proposal card', () => {
    const PROPOSAL_NUDGE = {
      kind: 'reschedule_proposal' as const,
      proposalId: 'proposal-1',
      meetingId: 'm-upcoming-1',
      optionCount: 2,
      originalScheduledStartIso: '2026-09-01T10:00:00Z',
      expiresAtIso: '2026-08-31T10:00:00Z',
      proposedAtIso: '2026-08-25T10:00:00Z',
      options: [{ optionId: 'opt-1', scheduledStartIso: '2026-09-02T10:00:00Z' }],
    };

    it('mounts on the CLIENT lens for a reschedule_proposal nudge', () => {
      render(<CaseSurface view={clientView({ nudge: PROPOSAL_NUDGE })} />);
      const stub = screen.getByTestId('reschedule-proposal-card-stub');
      expect(stub).toHaveTextContent('lens: client');
    });

    it('mounts on the EXPERT lens for a reschedule_proposal_pending nudge', () => {
      render(
        <CaseSurface
          view={expertView({ nudge: { ...PROPOSAL_NUDGE, kind: 'reschedule_proposal_pending' } })}
        />
      );
      const stub = screen.getByTestId('reschedule-proposal-card-stub');
      expect(stub).toHaveTextContent('lens: expert');
    });

    it('does NOT mount for any other nudge kind', () => {
      render(<CaseSurface view={clientView({ nudge: { kind: 'nothing_booked' } })} />);
      expect(screen.queryByTestId('reschedule-proposal-card-stub')).not.toBeInTheDocument();
    });

    it('router.refresh() fires when the card reports a change', async () => {
      const user = userEvent.setup();
      render(<CaseSurface view={clientView({ nudge: PROPOSAL_NUDGE })} />);
      await user.click(screen.getByRole('button', { name: 'Stub changed' }));
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });

  /** ⚠ A CLOSED CASE IS READ-ONLY BUT FULLY READABLE, and every card says so in its own way. */
  it('turns the whole surface retrospective on a CLOSED case', () => {
    // ⚠ `writable` is composed AT THE GATE from the engagement status, not re-derived from
    // `header.isOpen` — a closed case therefore arrives with BOTH set, and the fixture says so.
    render(
      <CaseSurface
        view={clientView({
          canClose: false,
          header: CLOSED_HEADER,
          conversation: { ...BASE.conversation, writable: false },
        })}
      />
    );
    expect(screen.getByText(CLOSED_HEADER.closedNote)).toBeInTheDocument();
    expect(
      screen.getByText('This case is closed, so the conversation is read-only.')
    ).toBeInTheDocument();
    expect(screen.getByText('No files were shared on this case.')).toBeInTheDocument();
    expect(screen.getByText('Starts a new case — this one stays as it is.')).toBeInTheDocument();
  });

  it('keeps the open case forward-looking instead', () => {
    render(<CaseSurface view={clientView()} />);
    expect(screen.queryByText('No files were shared on this case.')).not.toBeInTheDocument();
    expect(screen.getByText(/Share a file with Amara in the conversation/)).toBeInTheDocument();
    expect(
      screen.queryByText('Starts a new case — this one stays as it is.')
    ).not.toBeInTheDocument();
  });

  it('counts an EMPTY consultation list without inventing an empty state', () => {
    render(<CaseSurface view={clientView({ consultations: [] })} />);
    expect(screen.getByText('0 · newest last')).toBeInTheDocument();
  });

  it('renders a held consultation with its recap link and duration', () => {
    render(<CaseSurface view={clientView({ consultations: [HELD_CONSULTATION] })} />);
    expect(screen.getByText('1 · newest last')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/m-1?from=case_surface'
    );
    expect(screen.getByText('42 min')).toBeInTheDocument();
  });

  it('invites on an EMPTY action-items card and lists items once there are any', () => {
    const { unmount } = render(<CaseSurface view={clientView()} />);
    expect(screen.getByText(/Anything you agree to do on a call lands here/)).toBeInTheDocument();
    unmount();

    render(
      <CaseSurface
        view={clientView({
          actionItems: {
            ...BASE.actionItems,
            unassigned: [ACTION_ITEM],
            doneCount: 0,
            totalCount: 1,
          },
        })}
      />
    );
    expect(screen.getByText('0/1')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('lists files and states truncation out loud', () => {
    render(<CaseSurface view={clientView({ files: [CASE_FILE], filesTruncated: true })} />);
    expect(screen.getByRole('button', { name: 'Download intake-flow.pdf' })).toBeInTheDocument();
    expect(screen.getByText('Showing the most recent files.')).toBeInTheDocument();
  });
});

/**
 * ⚠⚠ THE SECRET-LEAK BOUNDARY (P3). `listMeetingsForContext` returns FULL `Meeting` rows
 * including `daily_room_name` and `join_url` — LIVE CALL-JOIN CREDENTIALS — and the projection
 * that strips them happens SERVER-SIDE. `CaseConsultationRowView` makes both fields
 * STRUCTURALLY UNREPRESENTABLE, so the only way to construct a row carrying them is the
 * assertion below; that is deliberate, and it is what makes this a real render-layer witness
 * rather than a restatement of the type. If any component ever spread a row into the DOM, these
 * values would appear and this test would fail.
 */
describe('CaseSurface — no meeting join secret crosses the projection boundary', () => {
  const LEAK_URL = 'https://balo.daily.co/leaked-room?t=secret-token';
  const LEAK_ROOM = 'leaked-room-9f3a';

  function rowWithSecrets(row: CaseConsultationRowView): CaseConsultationRowView {
    return { ...row, joinUrl: LEAK_URL, dailyRoomName: LEAK_ROOM } as CaseConsultationRowView;
  }

  it.each(LENSES)('renders neither joinUrl nor dailyRoomName, %s lens', (lens) => {
    const { container } = render(
      <CaseSurface
        view={viewForLens(lens, { consultations: [rowWithSecrets(HELD_CONSULTATION)] })}
      />
    );
    const html = container.innerHTML;
    expect(html).not.toContain(LEAK_URL);
    expect(html).not.toContain(LEAK_ROOM);
    expect(html).not.toContain('daily.co');
  });

  it('renders the meetingId only inside the recap href, never as a room address', () => {
    const { container } = render(
      <CaseSurface view={clientView({ consultations: [rowWithSecrets(HELD_CONSULTATION)] })} />
    );
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/m-1?from=case_surface'
    );
    // No absolute URL of any kind belongs in a consultation row.
    expect(container.innerHTML).not.toContain('https://');
  });
});
