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

import { toast } from 'sonner';
import { NudgeBar, nudgeFor, EXPERT_GATED_NUDGE } from './nudge-bar';
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
    const nudge = nudgeFor('expert', 'kickoff_approved')!;
    render(
      <NudgeBar nudge={nudge} lens="expert" status="kickoff_approved" requestId={REQUEST_ID} />
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
