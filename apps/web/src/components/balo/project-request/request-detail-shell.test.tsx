import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';
import type {
  RequestViewerContext,
  ProjectRequestStatus,
} from '@/lib/project-request/resolve-request-lens';

vi.mock('server-only', () => ({}));

const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

// AdminHealthPanel + NudgeActions are client islands that import server actions —
// mock them so the shell renders in JSDOM without hitting the network.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/remove-invited-expert', () => ({
  removeInvitedExpertAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-exploratory-meeting', () => ({
  requestExploratoryMeetingAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/book-exploratory', () => ({
  bookExploratoryMeetingAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite', () => ({
  searchExpertsForInviteAction: vi.fn(() => Promise.resolve({ success: true, experts: [] })),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/invite-experts', () => ({
  inviteExpertsAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-eoi', () => ({
  submitEoiAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/withdraw-eoi', () => ({
  withdrawEoiAction: vi.fn(),
}));

// Conversation-stage Server Actions (BAL-271) — mocked so the shell renders in
// JSDOM without touching @balo/db / auth / R2 modules at runtime.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/post-conversation-message', () => ({
  postConversationMessageAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/mark-thread-read', () => ({
  markThreadReadAction: vi.fn(() => Promise.resolve({ success: true })),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/fetch-thread', () => ({
  fetchThreadAction: vi.fn(() =>
    Promise.resolve({ success: true, messages: [], hasEarlier: false, files: [] })
  ),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-conversation-file-upload', () => ({
  requestConversationFileUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-conversation-file-upload', () => ({
  confirmConversationFileUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-conversation-file-download', () => ({
  getConversationFileDownloadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-conversation-call', () => ({
  requestConversationCallAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal', () => ({
  requestProposalAction: vi.fn(),
}));
// KickoffBoard (BAL-291) client island — mock its two actions so the shell
// renders the board in JSDOM without touching @balo/db / auth at runtime.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/complete-kickoff-task', () => ({
  completeKickoffTaskAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/approve-kickoff', () => ({
  approveKickoffAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-billing-details', () => ({
  submitBillingDetailsAction: vi.fn(),
}));
vi.mock(
  '@/app/(dashboard)/projects/[requestId]/_actions/create-conversation-realtime-token',
  () => ({ createConversationRealtimeTokenAction: vi.fn() })
);
// AdminFeeOverridePanel (BAL-358) client island imports its server action — mock it
// so the observer shell renders in JSDOM without touching @balo/db / auth.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/override-balo-fee', () => ({
  overrideBaloFee: vi.fn(),
}));

// useIsMobile reads window.matchMedia (absent in jsdom) — default to desktop.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

// EoiEntry mounts the code-split TipTap editor — mock the public module so the
// shell renders in JSDOM. A minimal contract is enough for shell-level assertions.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: () => <div data-testid="rt-editor" />,
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  validateDescription: () => null,
}));

import { RequestDetailShell } from './request-detail-shell';
import { track, BILLING_EVENTS } from '@/lib/analytics';
import { ConversationStage } from './conversation/conversation-stage';
import { EoiEntry } from './eoi-entry';
import { thread as conversationThread } from '@/test/fixtures/conversation';
import type { RequestRelationshipView } from '@/lib/project-request/request-detail-view';
import type { ConversationView } from '@/lib/project-request/conversation-view-types';

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    viewerUserId: 'user-viewer',
    threads: [conversationThread()],
    defaultThreadId: 'rel-1',
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
    ...overrides,
  };
}

function relationship(overrides: Partial<RequestRelationshipView> = {}): RequestRelationshipView {
  return {
    id: 'rel-1',
    expertName: 'Priya Nair',
    status: 'eoi_submitted',
    state: 'eoi_in',
    isQuiet: false,
    quietDays: 0,
    removable: false,
    ...overrides,
  };
}

function view(overrides: Partial<RequestDetailView> = {}): RequestDetailView {
  return {
    id: 'req-1',
    title: 'CPQ implementation',
    descriptionHtml: '<p>Brief</p>',
    products: [{ name: 'Revenue Cloud (CPQ)' }],
    tags: [],
    documents: [],
    companyName: 'Northwind Industrial',
    contact: { name: 'Dana Whitfield' },
    postedRelative: '3 days ago',
    status: 'requested',
    budget: null,
    baloFeeBps: 2500,
    timeline: null,
    relationships: [],
    viewerEoi: null,
    viewerRelationshipStatus: null,
    kickoff: null,
    ...overrides,
  };
}

function kickoff(
  overrides: Partial<NonNullable<RequestDetailView['kickoff']>> = {}
): NonNullable<RequestDetailView['kickoff']> {
  return {
    acceptedRelationshipId: 'rel-1',
    clientBillingConfirmed: false,
    expertTermsConfirmed: false,
    approved: false,
    expertName: 'Priya Nair',
    ...overrides,
  };
}

function ctx(overrides: Partial<RequestViewerContext> = {}): RequestViewerContext {
  return {
    lens: 'client',
    archetype: 'participant',
    isOwner: true,
    isInvitedExpert: false,
    relationshipId: null,
    canSeeContact: false,
    ...overrides,
  };
}

/** Collect every element of `type` in a (server-component) element tree. */
function findAllOfType(node: unknown, type: React.ElementType): React.ReactElement[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((child) => findAllOfType(child, type));
  }
  const el = node as React.ReactElement<{ children?: unknown }>;
  const here = el.type === type ? [el] : [];
  return [...here, ...findAllOfType(el.props?.children, type)];
}

describe('RequestDetailShell — Lens × Status matrix', () => {
  it('client before Phase 2 renders the full hero (no conversation)', () => {
    render(<RequestDetailShell view={view({ status: 'requested' })} ctx={ctx()} />);
    expect(screen.getByRole('heading', { name: /CPQ implementation/i })).toBeInTheDocument();
    expect(screen.queryByText(/Your conversation lives here/i)).not.toBeInTheDocument();
  });

  it('client at Phase 2 without a payload renders the empty conversation stage + compact panel', () => {
    render(<RequestDetailShell view={view({ status: 'eoi_submitted' })} ctx={ctx()} />);
    expect(screen.getByText(/Your conversation lives here/i)).toBeInTheDocument();
    expect(screen.getByText('The request')).toBeInTheDocument();
  });

  it('client at Phase 2 with a payload renders the LIVE conversation stage', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'eoi_submitted' })}
        ctx={ctx()}
        conversation={conversation()}
      />
    );
    // The live stage: the expert thread identity + composer, no placeholder copy.
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toBeInTheDocument();
    expect(screen.queryByText(/Your conversation lives here/i)).not.toBeInTheDocument();
  });

  it('keys the conversation island by request id (remounts across /projects/A → /projects/B)', () => {
    // The shell is a sync server component — call it and walk the element tree
    // (RTL can't observe React keys in the DOM).
    const element = RequestDetailShell({
      view: view({ status: 'eoi_submitted' }),
      ctx: ctx(),
      conversation: conversation(),
    });
    const findStage = (node: unknown): React.ReactElement | null => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findStage(child);
          if (found !== null) return found;
        }
        return null;
      }
      const el = node as React.ReactElement<{ children?: unknown }>;
      if (el.type === ConversationStage) return el;
      return findStage(el.props?.children);
    };
    const stage = findStage(element);
    expect(stage).not.toBeNull();
    expect(stage?.key).toBe('req-1');
  });

  it('keys every EoiEntry card by request id (no EOI state bleed across /projects/A → /projects/B)', () => {
    // BAL-280: EoiEntry holds per-request draft state and must remount on request
    // change — same fix shape as ConversationStage above. Walk the element tree
    // (RTL can't observe React keys in the DOM) at both phases the card renders.

    // Phase-1 expert: the EOI card sits under the brief (one render site).
    const phase1 = RequestDetailShell({
      view: view({
        status: 'experts_invited',
        viewerEoi: { hasLiveEoi: false, messageHtml: null },
      }),
      ctx: ctx({ lens: 'expert', isOwner: false }),
    });
    const phase1Entries = findAllOfType(phase1, EoiEntry);
    expect(phase1Entries.length).toBeGreaterThan(0);
    for (const entry of phase1Entries) {
      expect(entry.key).toBe('req-1');
    }

    // Phase-2 expert: the compact card renders at both the mobile sheet and the
    // desktop right column — every instance must be keyed.
    const phase2 = RequestDetailShell({
      view: view({
        status: 'eoi_submitted',
        viewerEoi: { hasLiveEoi: false, messageHtml: null },
      }),
      ctx: ctx({ lens: 'expert', isOwner: false }),
      conversation: conversation(),
    });
    const phase2Entries = findAllOfType(phase2, EoiEntry);
    expect(phase2Entries.length).toBeGreaterThan(0);
    for (const entry of phase2Entries) {
      expect(entry.key).toBe('req-1');
    }
  });

  it('Phase 2 renders the mobile slim request bar that opens the details sheet', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'eoi_submitted' })}
        ctx={ctx()}
        conversation={conversation()}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Request details: CPQ implementation' })
    ).toBeInTheDocument();
  });

  it('uninvited expert before invite is gated with the lock card', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'requested' })}
        ctx={ctx({ lens: 'expert', isOwner: false, canSeeContact: true })}
      />
    );
    expect(screen.getByText(/isn't open to experts yet/i)).toBeInTheDocument();
    expect(screen.getByText('Not yet visible to you')).toBeInTheDocument();
  });

  it('invited expert at experts_invited sees Phase 1 hero (not gated)', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'experts_invited' })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.queryByText(/isn't open to experts yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /CPQ implementation/i })).toBeInTheDocument();
    expect(screen.getByText(/submit your expression of interest/i)).toBeInTheDocument();
  });

  it('expert Phase-1 renders the EoiEntry compose card below the brief', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'experts_invited',
          viewerEoi: { hasLiveEoi: false, messageHtml: null },
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.getByText('Express your interest')).toBeInTheDocument();
  });

  it('expert Phase-2 renders the gated ProposalSlot pill (and the EOI card stays reachable)', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'eoi_submitted',
          viewerEoi: { hasLiveEoi: true, messageHtml: '<p>My pitch</p>' },
          viewerRelationshipStatus: 'eoi_submitted',
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
    expect(screen.getByText('Interest sent')).toBeInTheDocument();
  });

  it('BAL-272 divergence: expert B at request proposal_requested still sees the AWAITING pill + meet nudge', () => {
    // Another expert's proposal advanced the REQUEST status; this viewer's own
    // relationship is still eoi_submitted — no false "Build proposal" prompt.
    render(
      <RequestDetailShell
        view={view({
          status: 'proposal_requested',
          viewerEoi: { hasLiveEoi: true, messageHtml: '<p>My pitch</p>' },
          viewerRelationshipStatus: 'eoi_submitted',
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
    expect(screen.getByText('Offer the client a time to talk')).toBeInTheDocument();
    expect(screen.queryByText(/Your proposal was requested/)).not.toBeInTheDocument();
  });

  it('BAL-272: the REQUESTED expert at proposal_requested gets the build nudge, no awaiting pill', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'proposal_requested',
          viewerEoi: { hasLiveEoi: true, messageHtml: '<p>My pitch</p>' },
          viewerRelationshipStatus: 'proposal_requested',
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.queryByText('Awaiting proposal request')).not.toBeInTheDocument();
    expect(screen.getByText('Your proposal was requested — build it')).toBeInTheDocument();
  });

  it('client Phase-1 does NOT render the EoiEntry card (no viewerEoi)', () => {
    render(<RequestDetailShell view={view({ status: 'experts_invited' })} ctx={ctx()} />);
    expect(screen.queryByText('Express your interest')).not.toBeInTheDocument();
  });

  it('client Phase-2 does NOT render the ProposalSlot or EoiEntry', () => {
    render(<RequestDetailShell view={view({ status: 'eoi_submitted' })} ctx={ctx()} />);
    expect(screen.queryByText('Awaiting proposal request')).not.toBeInTheDocument();
    expect(screen.queryByText('Express your interest')).not.toBeInTheDocument();
  });

  it('admin observer renders the full request and (once invited) the health panel', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'eoi_submitted',
          relationships: [relationship()],
        })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', isOwner: false, canSeeContact: true })}
      />
    );
    expect(screen.getByText('Pipeline health')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    // Admin observer never gets the conversation stage.
    expect(screen.queryByText(/Your conversation lives here/i)).not.toBeInTheDocument();
  });

  it('admin observer hides the health panel when there are no relationships', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'requested', relationships: [] })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', isOwner: false, canSeeContact: true })}
      />
    );
    expect(screen.queryByText('Pipeline health')).not.toBeInTheDocument();
  });

  it('renders the "Viewing as" lens line', () => {
    render(<RequestDetailShell view={view()} ctx={ctx()} />);
    expect(screen.getByText('Viewing as')).toBeInTheDocument();
    expect(screen.getByText('Client')).toBeInTheDocument();
  });

  it('shows a phase pill for participants but not observers', () => {
    const { rerender } = render(<RequestDetailShell view={view()} ctx={ctx()} />);
    expect(screen.getByText('Phase 1 — request')).toBeInTheDocument();
    rerender(
      <RequestDetailShell
        view={view({ status: 'eoi_submitted' })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', canSeeContact: true })}
      />
    );
    expect(screen.queryByText(/Phase \d/)).not.toBeInTheDocument();
  });

  it('mounts the status stepper marking the current step for every lens', () => {
    // Client participant.
    const { rerender } = render(
      <RequestDetailShell view={view({ status: 'eoi_submitted' })} ctx={ctx()} />
    );
    expect(screen.getByRole('list', { name: /Request progress/i })).toBeInTheDocument();
    expect(screen.getByText('EOIs in').closest('[aria-current="step"]')).not.toBeNull();

    // Admin observer — stepper still present.
    rerender(
      <RequestDetailShell
        view={view({ status: 'proposal_submitted' })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', canSeeContact: true })}
      />
    );
    expect(screen.getByRole('list', { name: /Request progress/i })).toBeInTheDocument();
    expect(screen.getByText('Proposals in').closest('[aria-current="step"]')).not.toBeNull();

    // Gated expert — stepper still present (at-a-glance position even while locked).
    rerender(
      <RequestDetailShell
        view={view({ status: 'requested' })}
        ctx={ctx({ lens: 'expert', isOwner: false, canSeeContact: false })}
      />
    );
    expect(screen.getByRole('list', { name: /Request progress/i })).toBeInTheDocument();
    expect(screen.getByText('Requested').closest('[aria-current="step"]')).not.toBeNull();
  });
});

describe('RequestDetailShell — delivery-workspace deep-link (BAL-331)', () => {
  it('renders the "View delivery workspace" link at kickoff_approved when an engagement id is set', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'kickoff_approved', kickoff: kickoff({ approved: true }) })}
        ctx={ctx()}
        conversation={conversation()}
        deliveryEngagementId="eng-42"
      />
    );
    const link = screen.getByRole('link', { name: /View delivery workspace/i });
    expect(link).toHaveAttribute('href', '/engagements/eng-42?from=request_detail');
  });

  it('surfaces the link for the delivering expert lens too', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'kickoff_approved',
          viewerRelationshipStatus: 'accepted',
          kickoff: kickoff({ approved: true }),
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
        conversation={conversation()}
        deliveryEngagementId="eng-42"
      />
    );
    expect(screen.getByRole('link', { name: /View delivery workspace/i })).toHaveAttribute(
      'href',
      '/engagements/eng-42?from=request_detail'
    );
  });

  it('omits the link when no delivery engagement id is provided', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'kickoff_approved', kickoff: kickoff({ approved: true }) })}
        ctx={ctx()}
        conversation={conversation()}
      />
    );
    expect(
      screen.queryByRole('link', { name: /View delivery workspace/i })
    ).not.toBeInTheDocument();
  });

  it('omits the link at earlier statuses (the page only resolves an id at kickoff_approved)', () => {
    // The page passes `deliveryEngagementId` ONLY at kickoff_approved, so a pre-
    // kickoff request never carries one → no link.
    render(<RequestDetailShell view={view({ status: 'eoi_submitted' })} ctx={ctx()} />);
    expect(
      screen.queryByRole('link', { name: /View delivery workspace/i })
    ).not.toBeInTheDocument();
  });
});

describe('RequestDetailShell — KickoffBoard mounting (BAL-291)', () => {
  it('renders the KickoffBoard in the admin observer right column when kickoff is populated', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'accepted',
          relationships: [relationship({ status: 'accepted', state: 'accepted' })],
          kickoff: kickoff(),
        })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', isOwner: false, canSeeContact: true })}
      />
    );
    expect(screen.getByText("What's blocking kickoff")).toBeInTheDocument();
  });

  it('renders the KickoffBoard for the client participant (Phase-2 right column)', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'accepted', kickoff: kickoff() })}
        ctx={ctx({ lens: 'client' })}
        conversation={conversation()}
      />
    );
    // Desktop + mobile-sheet both mount the board → at least one heading is present.
    expect(screen.getAllByText("What's blocking kickoff").length).toBeGreaterThanOrEqual(1);
  });

  it('renders the KickoffBoard for the winning expert participant (Phase-2 right column)', () => {
    render(
      <RequestDetailShell
        view={view({
          status: 'accepted',
          viewerRelationshipStatus: 'accepted',
          kickoff: kickoff(),
        })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
        conversation={conversation()}
      />
    );
    expect(screen.getAllByText("What's blocking kickoff").length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT render the KickoffBoard when kickoff is null (default fixtures)', () => {
    render(<RequestDetailShell view={view({ status: 'eoi_submitted' })} ctx={ctx()} />);
    expect(screen.queryByText("What's blocking kickoff")).not.toBeInTheDocument();
  });
});

describe('RequestDetailShell — AdminFeeOverridePanel mounting (BAL-358)', () => {
  it('renders the Balo fee override panel for the observer lens (even before any expert is invited)', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'requested', relationships: [] })}
        ctx={ctx({ lens: 'admin', archetype: 'observer', isOwner: false, canSeeContact: true })}
      />
    );
    expect(screen.getByRole('heading', { name: 'Balo fee' })).toBeInTheDocument();
  });

  it('does NOT render the fee panel for the client participant lens', () => {
    render(<RequestDetailShell view={view({ status: 'requested' })} ctx={ctx()} />);
    expect(screen.queryByRole('heading', { name: 'Balo fee' })).not.toBeInTheDocument();
  });

  it('does NOT render the fee panel for the expert participant lens', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'experts_invited' })}
        ctx={ctx({
          lens: 'expert',
          isInvitedExpert: true,
          relationshipId: 'rel-1',
          canSeeContact: true,
        })}
      />
    );
    expect(screen.queryByRole('heading', { name: 'Balo fee' })).not.toBeInTheDocument();
  });
});

// Type guard: every status compiles into the shell (matrix completeness).
const ALL_STATUSES: ProjectRequestStatus[] = [
  'draft',
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
];

describe('RequestDetailShell — renders for every status', () => {
  it.each(ALL_STATUSES)('renders without throwing for status=%s (client)', (status) => {
    render(<RequestDetailShell view={view({ status })} ctx={ctx()} />);
    expect(screen.getByText('Viewing as')).toBeInTheDocument();
  });
});

describe('RequestDetailShell — billing blocked-view analytics (BAL-323)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const blockedView = view({ status: 'accepted', kickoff: kickoff() });

  it('fires billing_details_blocked_view exactly once for a blocked client member', () => {
    render(
      <RequestDetailShell
        view={blockedView}
        ctx={ctx()}
        billingCapture={{ companyId: 'company-1', canManage: false, details: null }}
      />
    );
    expect(track).toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, {
      company_id: 'company-1',
      request_id: 'req-1',
    });
    // Once — not per KickoffBoard mount (desktop column + mobile sheet).
    const blockedCalls = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === BILLING_EVENTS.DETAILS_BLOCKED_VIEW);
    expect(blockedCalls).toHaveLength(1);
  });

  it('does not fire for an owner/admin who can manage billing', () => {
    render(
      <RequestDetailShell
        view={blockedView}
        ctx={ctx()}
        billingCapture={{ companyId: 'company-1', canManage: true, details: null }}
      />
    );
    expect(track).not.toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, expect.anything());
  });

  it('does not fire once billing is already confirmed', () => {
    render(
      <RequestDetailShell
        view={view({ status: 'accepted', kickoff: kickoff({ clientBillingConfirmed: true }) })}
        ctx={ctx()}
        billingCapture={{ companyId: 'company-1', canManage: false, details: null }}
      />
    );
    expect(track).not.toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, expect.anything());
  });
});
