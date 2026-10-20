import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';

// The island imports these server actions — mock so it renders without network.
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
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockPassOnRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/pass-on-request', () => ({
  passOnRequestAction: mockPassOnRequest,
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { NudgeActions } from './nudge-actions';
import { ExpertCallBridgeProvider, useRegisterExpertProposeTimes } from './expert-call-bridge';

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-build-1';
const BUILD_PRIMARY = { label: 'Build proposal', icon: 'fileText' } as const;

describe('NudgeActions — A6.2 build-proposal CTA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to the composer when wired with a relationship id', () => {
    render(
      <NudgeActions
        lens="expert"
        status="proposal_requested"
        requestId={REQUEST_ID}
        viewerRelationshipId={RELATIONSHIP_ID}
        primary={BUILD_PRIMARY}
      />
    );
    const cta = screen.getByRole('button', { name: /Build proposal/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/${RELATIONSHIP_ID}`);
  });

  it('renders the CTA disabled (no navigation) when no relationship id is provided', () => {
    render(
      <NudgeActions
        lens="expert"
        status="proposal_requested"
        requestId={REQUEST_ID}
        primary={BUILD_PRIMARY}
      />
    );
    const cta = screen.getByRole('button', { name: /Build proposal/i });
    expect(cta).toBeDisabled();
    fireEvent.click(cta);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not wire build-proposal for a non-matching cell (client lens)', () => {
    render(
      <NudgeActions
        lens="client"
        status="proposal_requested"
        requestId={REQUEST_ID}
        viewerRelationshipId={RELATIONSHIP_ID}
        primary={BUILD_PRIMARY}
      />
    );
    // No WIRED['client:proposal_requested'] entry → the CTA renders disabled.
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeDisabled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a descriptor's own action wires a cell with no WIRED entry — dialog mount included", () => {
    render(
      <NudgeActions
        lens="client"
        status="proposal_submitted"
        requestId={REQUEST_ID}
        primary={{ label: 'Invite experts', icon: 'users', action: 'invite' }}
      />
    );
    const cta = screen.getByRole('button', { name: /Invite experts/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(screen.getByRole('dialog', { name: /Invite experts/i })).toBeInTheDocument();
  });
});

describe('NudgeActions — direct-request choice CTAs (BAL-604)', () => {
  const PROPOSE = { label: 'Propose times', icon: 'calendar', action: 'propose-times' } as const;
  const PASS = { label: 'Pass on this project', icon: 'x', action: 'pass' } as const;
  const PASS_ON = {
    requestTitle: 'CPQ implementation',
    relationshipStatus: 'eoi_submitted',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function StageStandIn({
    onPropose,
    pending = false,
  }: Readonly<{ onPropose: () => void; pending?: boolean }>): null {
    useRegisterExpertProposeTimes(onPropose, pending);
    return null;
  }

  it('"Propose times" runs the handler the conversation stage registered', () => {
    const onPropose = vi.fn();
    render(
      <ExpertCallBridgeProvider>
        <StageStandIn onPropose={onPropose} />
        <NudgeActions
          lens="expert"
          status="eoi_submitted"
          requestId={REQUEST_ID}
          primary={PROPOSE}
          secondary={PASS}
          passOn={PASS_ON}
        />
      </ExpertCallBridgeProvider>
    );
    const cta = screen.getByRole('button', { name: 'Propose times' });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it('"Propose times" is disabled and reads "Sharing…" while the stage call is pending', () => {
    const onPropose = vi.fn();
    render(
      <ExpertCallBridgeProvider>
        <StageStandIn onPropose={onPropose} pending />
        <NudgeActions
          lens="expert"
          status="eoi_submitted"
          requestId={REQUEST_ID}
          primary={PROPOSE}
        />
      </ExpertCallBridgeProvider>
    );
    const cta = screen.getByRole('button', { name: 'Sharing…' });
    expect(cta).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Propose times' })).not.toBeInTheDocument();
  });

  it('"Propose times" stays disabled when no stage registered a handler', () => {
    render(
      <ExpertCallBridgeProvider>
        <NudgeActions
          lens="expert"
          status="eoi_submitted"
          requestId={REQUEST_ID}
          primary={PROPOSE}
        />
      </ExpertCallBridgeProvider>
    );
    expect(screen.getByRole('button', { name: 'Propose times' })).toBeDisabled();
  });

  it('"Pass on this project" opens the pass confirm dialog', async () => {
    render(
      <NudgeActions
        lens="expert"
        status="eoi_submitted"
        requestId={REQUEST_ID}
        secondary={PASS}
        passOn={PASS_ON}
      />
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pass on this project' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Pass on this project?');
  });

  it('confirming the pass from the nudge records the nudge surface', async () => {
    mockPassOnRequest.mockResolvedValue({ success: true });
    render(
      <NudgeActions
        lens="expert"
        status="eoi_submitted"
        requestId={REQUEST_ID}
        secondary={PASS}
        passOn={PASS_ON}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pass on this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass' }));
    await waitFor(() =>
      expect(mockPassOnRequest).toHaveBeenCalledWith({ requestId: REQUEST_ID, surface: 'nudge' })
    );
  });

  it('"Pass on this project" is disabled without a passable track', () => {
    render(
      <NudgeActions lens="expert" status="eoi_submitted" requestId={REQUEST_ID} secondary={PASS} />
    );
    expect(screen.getByRole('button', { name: 'Pass on this project' })).toBeDisabled();
  });
});
