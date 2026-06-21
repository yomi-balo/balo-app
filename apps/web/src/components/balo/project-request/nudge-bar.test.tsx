import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';

// The NudgeActions island imports these server actions; mock them so the bar
// renders + the wired CTAs can be exercised without hitting the network.
const mockRequestExploratory = vi.fn();
const mockBookExploratory = vi.fn();
const mockSearchExperts = vi.fn();
const mockInviteExperts = vi.fn();

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-exploratory-meeting', () => ({
  requestExploratoryMeetingAction: (...args: unknown[]) => mockRequestExploratory(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/book-exploratory', () => ({
  bookExploratoryMeetingAction: (...args: unknown[]) => mockBookExploratory(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite', () => ({
  searchExpertsForInviteAction: (...args: unknown[]) => mockSearchExperts(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/invite-experts', () => ({
  inviteExpertsAction: (...args: unknown[]) => mockInviteExperts(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { Zap } from 'lucide-react';
import { toast } from 'sonner';
import { NudgeBar, nudgeFor, EXPERT_GATED_NUDGE, type NudgeContent } from './nudge-bar';
import { track, PROJECT_EVENTS } from '@/lib/analytics';

const mockToast = vi.mocked(toast);

const REQUEST_ID = 'req-1';

describe('NudgeBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchExperts.mockResolvedValue({ success: true, experts: [] });
  });

  it('renders the headline, sub, and the action eyebrow', () => {
    const nudge = nudgeFor('expert', 'experts_invited')!;
    render(
      <NudgeBar nudge={nudge} lens="expert" status="experts_invited" requestId={REQUEST_ID} />
    );
    expect(screen.getByText(/submit your expression of interest/i)).toBeInTheDocument();
    expect(screen.getByText('Your next step')).toBeInTheDocument();
  });

  it('leaves CTAs owned by later slices disabled (expert EOI CTA)', () => {
    const nudge = nudgeFor('expert', 'experts_invited')!;
    render(
      <NudgeBar nudge={nudge} lens="expert" status="experts_invited" requestId={REQUEST_ID} />
    );
    expect(screen.getByRole('button', { name: /Write your EOI/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Re-read the brief/i })).toBeDisabled();
  });

  it('renders the Waiting eyebrow for waiting variants', () => {
    render(
      <NudgeBar
        nudge={EXPERT_GATED_NUDGE}
        lens="expert"
        status="requested"
        requestId={REQUEST_ID}
      />
    );
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Not yet visible to you')).toBeInTheDocument();
  });

  it('renders the Done eyebrow for done variants', () => {
    // The accepted/kickoff_approved cells now defer to the KickoffBoard (no map
    // entry), so construct a done nudge directly to exercise the eyebrow.
    const doneNudge: NudgeContent = {
      variant: 'done',
      icon: Zap,
      headline: 'All wrapped up',
    };
    render(
      <NudgeBar nudge={doneNudge} lens="expert" status="kickoff_approved" requestId={REQUEST_ID} />
    );
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

describe('NudgeBar — A2 wired admin CTAs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchExperts.mockResolvedValue({ success: true, experts: [] });
  });

  it('enables the admin triage CTAs at requested', () => {
    const nudge = nudgeFor('admin', 'requested')!;
    render(<NudgeBar nudge={nudge} lens="admin" status="requested" requestId={REQUEST_ID} />);
    expect(screen.getByRole('button', { name: /Invite experts/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Request exploratory call/i })).toBeEnabled();
  });

  it('requesting an exploratory call calls the action, toasts, and fires analytics', async () => {
    mockRequestExploratory.mockResolvedValue({
      success: true,
      from: 'requested',
      to: 'exploratory_meeting_requested',
      firstAdminActionMs: 1000,
    });
    const nudge = nudgeFor('admin', 'requested')!;
    render(<NudgeBar nudge={nudge} lens="admin" status="requested" requestId={REQUEST_ID} />);

    fireEvent.click(screen.getByRole('button', { name: /Request exploratory call/i }));

    await waitFor(() => {
      expect(mockRequestExploratory).toHaveBeenCalledWith({ requestId: REQUEST_ID });
    });
    expect(mockToast.success).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'requested',
      to: 'exploratory_meeting_requested',
      actor: 'admin',
      time_to_first_admin_action_ms: 1000,
    });
  });

  it('toasts the error when requesting an exploratory call fails', async () => {
    mockRequestExploratory.mockResolvedValue({ success: false, error: 'Nope.' });
    const nudge = nudgeFor('admin', 'requested')!;
    render(<NudgeBar nudge={nudge} lens="admin" status="requested" requestId={REQUEST_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Request exploratory call/i }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Nope.'));
    expect(track).not.toHaveBeenCalled();
  });

  it('opens the invite dialog from the admin primary CTA', async () => {
    const nudge = nudgeFor('admin', 'requested')!;
    render(<NudgeBar nudge={nudge} lens="admin" status="requested" requestId={REQUEST_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Invite experts/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Invite experts/i })).toBeInTheDocument()
    );
  });

  it('enables the client "Book exploratory call" CTA and runs the mock booking', async () => {
    mockBookExploratory.mockResolvedValue({
      success: true,
      mocked: true,
      confirmation: { message: 'Your exploratory call is booked.', scheduledAtIso: null },
    });
    const nudge = nudgeFor('client', 'exploratory_meeting_requested')!;
    render(
      <NudgeBar
        nudge={nudge}
        lens="client"
        status="exploratory_meeting_requested"
        requestId={REQUEST_ID}
      />
    );
    const cta = screen.getByRole('button', { name: /Book exploratory call/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    await waitFor(() =>
      expect(mockBookExploratory).toHaveBeenCalledWith({ requestId: REQUEST_ID })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Your exploratory call is booked.');
  });
});

describe('NudgeBar — A6.2 expert build-proposal CTA (page-level activation gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RELATIONSHIP_ID = 'rel-build-1';

  it('navigates the expert to the composer when the relationship id is provided', () => {
    const nudge = nudgeFor('expert', 'proposal_requested', 'proposal_requested')!;
    render(
      <NudgeBar
        nudge={nudge}
        lens="expert"
        status="proposal_requested"
        requestId={REQUEST_ID}
        viewerRelationshipId={RELATIONSHIP_ID}
      />
    );
    const cta = screen.getByRole('button', { name: /Build proposal/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/${RELATIONSHIP_ID}`);
  });

  it('stays disabled (copy alone does not enable) when no relationship id is threaded', () => {
    const nudge = nudgeFor('expert', 'proposal_requested', 'proposal_requested')!;
    render(
      <NudgeBar nudge={nudge} lens="expert" status="proposal_requested" requestId={REQUEST_ID} />
    );
    const cta = screen.getByRole('button', { name: /Build proposal/i });
    expect(cta).toBeDisabled();
    fireEvent.click(cta);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('nudgeFor', () => {
  it('returns a client nudge for a known client status', () => {
    expect(nudgeFor('client', 'requested')?.variant).toBe('waiting');
  });

  it('returns an admin triage nudge at requested', () => {
    expect(nudgeFor('admin', 'requested')?.headline).toMatch(/triage/i);
  });

  it('returns null for a cell with no nudge (client at eoi_submitted)', () => {
    expect(nudgeFor('client', 'eoi_submitted')).toBeNull();
  });

  it('covers every lens for the experts_invited status', () => {
    expect(nudgeFor('client', 'experts_invited')).not.toBeNull();
    expect(nudgeFor('expert', 'experts_invited')).not.toBeNull();
    expect(nudgeFor('admin', 'experts_invited')).not.toBeNull();
  });
});

describe('nudgeFor — expert relationship keying (BAL-272 divergence fix)', () => {
  it('keys the expert proposal-phase cell by the VIEWER relationship, not the request aggregate', () => {
    // Request advanced via another expert; this viewer is still eoi_submitted.
    const nudge = nudgeFor('expert', 'proposal_requested', 'eoi_submitted');
    expect(nudge?.headline).toBe('Offer the client a time to talk');
  });

  it('the requested expert gets the live build cell (A6.2 — composer wired)', () => {
    const nudge = nudgeFor('expert', 'proposal_requested', 'proposal_requested');
    expect(nudge?.headline).toBe('Your proposal was requested — build it');
    expect(nudge?.sub).toBe(
      'Lay out scope, milestones and pricing. You can save a draft and submit when ready.'
    );
  });

  it('an expert whose proposal is in stays on the waiting cell at request proposal_submitted+', () => {
    expect(nudgeFor('expert', 'proposal_submitted', 'proposal_submitted')?.headline).toBe(
      'Your proposal is with the client'
    );
    expect(nudgeFor('expert', 'proposal_submitted', 'eoi_submitted')?.headline).toBe(
      'Offer the client a time to talk'
    );
  });

  it("an invited-but-quiet expert gets the EOI cell, never another expert's aggregate", () => {
    // The REQUEST advanced via other experts; this viewer hasn't submitted an
    // EOI yet — their true next step is the EOI, not the aggregate cell.
    expect(nudgeFor('expert', 'eoi_submitted', 'invited')?.headline).toBe(
      "You're invited — submit your expression of interest"
    );
  });

  it("('proposal_requested','invited') never shows the false build-it prompt", () => {
    const nudge = nudgeFor('expert', 'proposal_requested', 'invited');
    expect(nudge?.headline).toBe("You're invited — submit your expression of interest");
    expect(nudge?.headline).not.toMatch(/build/i);
  });

  it('a declined expert gets no nudge (suppressed, no aggregate fallback)', () => {
    expect(nudgeFor('expert', 'proposal_requested', 'declined')).toBeNull();
    expect(nudgeFor('expert', 'eoi_submitted', 'declined')).toBeNull();
  });

  it('accepted/kickoff cells defer to the KickoffBoard (BAL-291) — no global nudge', () => {
    // The KickoffBoard owns all kickoff messaging + actions at these statuses, so
    // the global nudge must NOT show a conflicting CTA for any lens.
    expect(nudgeFor('expert', 'accepted', 'accepted')).toBeNull();
    expect(nudgeFor('expert', 'kickoff_approved', 'accepted')).toBeNull();
    expect(nudgeFor('client', 'accepted')).toBeNull();
    expect(nudgeFor('client', 'kickoff_approved')).toBeNull();
    expect(nudgeFor('admin', 'accepted')).toBeNull();
    expect(nudgeFor('admin', 'kickoff_approved')).toBeNull();
  });

  it('never changes the client/admin maps', () => {
    expect(nudgeFor('client', 'proposal_requested', 'eoi_submitted')).toBeNull();
    expect(nudgeFor('admin', 'proposal_requested', 'eoi_submitted')?.headline).toBe(
      'Proposals requested'
    );
  });
});

describe('nudgeFor — non-winning / declined expert suppression (BAL-286)', () => {
  // Item 2: `experts_invited` sits OUTSIDE the relationship-keyed proposal band,
  // so before the fix a `declined` viewer fell through to the request-keyed map
  // and saw a false "You're invited — submit your EOI" prompt for a thread they
  // walked away from. The declined short-circuit must hold at EVERY request status.
  it('a declined expert gets no nudge even at the pre-EOI experts_invited status', () => {
    expect(nudgeFor('expert', 'experts_invited', 'declined')).toBeNull();
    expect(nudgeFor('expert', 'exploratory_meeting_requested', 'declined')).toBeNull();
    expect(nudgeFor('expert', 'requested', 'declined')).toBeNull();
  });

  it('an INVITED expert still gets the EOI cell at experts_invited (no regression)', () => {
    expect(nudgeFor('expert', 'experts_invited', 'invited')?.headline).toBe(
      "You're invited — submit your expression of interest"
    );
  });

  // Item 1: at a DECIDED request the page nudge is keyed on the viewer's OUTCOME,
  // never the max-progress aggregate — so a LOSING expert (relationship frozen at
  // any pre-accept status) never inherits the winner's kickoff prompt. Both the
  // winner (KickoffBoard owns it) and every loser are suppressed at page level.
  it('a losing expert sees no page nudge at accepted/kickoff_approved (any frozen status)', () => {
    for (const decided of ['accepted', 'kickoff_approved'] as const) {
      for (const frozen of [
        'invited',
        'eoi_submitted',
        'proposal_requested',
        'proposal_submitted',
      ] as const) {
        expect(nudgeFor('expert', decided, frozen)).toBeNull();
      }
    }
  });

  it('the winning expert is also suppressed at page level (KickoffBoard owns kickoff)', () => {
    expect(nudgeFor('expert', 'accepted', 'accepted')).toBeNull();
    expect(nudgeFor('expert', 'kickoff_approved', 'accepted')).toBeNull();
  });
});
