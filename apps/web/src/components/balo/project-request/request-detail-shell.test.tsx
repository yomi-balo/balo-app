import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';
import type {
  RequestViewerContext,
  ProjectRequestStatus,
} from '@/lib/project-request/resolve-request-lens';

vi.mock('server-only', () => ({}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
vi.mock(
  '@/app/(dashboard)/projects/[requestId]/_actions/create-conversation-realtime-token',
  () => ({ createConversationRealtimeTokenAction: vi.fn() })
);

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
import { ConversationStage } from './conversation/conversation-stage';
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
    timeline: null,
    relationships: [],
    viewerEoi: null,
    viewerRelationshipStatus: null,
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
