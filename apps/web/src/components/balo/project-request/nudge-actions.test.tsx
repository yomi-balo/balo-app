import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import { FileText } from 'lucide-react';

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

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { NudgeActions } from './nudge-actions';

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-build-1';
const BUILD_PRIMARY = { label: 'Build proposal', icon: FileText };

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
});
