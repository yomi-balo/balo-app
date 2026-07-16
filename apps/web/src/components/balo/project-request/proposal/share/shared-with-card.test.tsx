import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { SharedLinkView } from '@/lib/project-request/proposal/share-view-types';

const mockRevoke = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share', () => ({
  revokeProposalShareLink: (...a: unknown[]) => mockRevoke(...a),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { SharedWithCard } from './shared-with-card';
import { toast } from 'sonner';

const LINKS: SharedLinkView[] = [
  {
    id: 'link-1',
    recipientEmail: 'alex@northwind.com',
    sharedOnIso: '2026-07-10T00:00:00Z',
    lastAccessedIso: '2026-07-12T00:00:00Z',
    expiresAtIso: '2026-08-09T00:00:00Z',
  },
  {
    id: 'link-2',
    recipientEmail: 'mo@northwind.com',
    sharedOnIso: '2026-07-14T00:00:00Z',
    lastAccessedIso: null,
    expiresAtIso: '2026-08-13T00:00:00Z',
  },
];

function renderCard(props: Partial<React.ComponentProps<typeof SharedWithCard>> = {}): void {
  render(<SharedWithCard requestId="req-1" relationshipId="rel-1" links={LINKS} {...props} />);
}

describe('SharedWithCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders loaded rows with an active-link count pill', () => {
    renderCard();
    expect(screen.getByText('alex@northwind.com')).toBeInTheDocument();
    expect(screen.getByText('mo@northwind.com')).toBeInTheDocument();
    expect(screen.getByText('2 active links')).toBeInTheDocument();
    expect(screen.getByText('Not opened yet')).toBeInTheDocument();
  });

  it('shows each link its own per-row expiry (helpful-fact framing)', () => {
    renderCard();
    expect(screen.getByText('Works until 9 August 2026')).toBeInTheDocument();
    expect(screen.getByText('Works until 13 August 2026')).toBeInTheDocument();
  });

  it('renders the invitation empty state (never absence-framed as hidden)', () => {
    renderCard({ links: [] });
    expect(screen.getByText('No one outside your team has access yet.')).toBeInTheDocument();
  });

  it('renders skeletons in the loading state', () => {
    const { container } = render(
      <SharedWithCard requestId="req-1" relationshipId="rel-1" links={[]} status="loading" />
    );
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders a retryable error banner', () => {
    renderCard({ status: 'error' });
    expect(
      screen.getByText(/We couldn.t load who this proposal is shared with/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('requires inline confirmation before revoking, then withdraws', async () => {
    mockRevoke.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderCard();

    // First click reveals the inline confirm — no action yet.
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    expect(screen.getByText('Withdraw access?')).toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(mockRevoke).toHaveBeenCalledWith({
        requestId: 'req-1',
        relationshipId: 'rel-1',
        linkId: 'link-1',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Access withdrawn');
  });

  it('cancels the revoke when "Keep" is pressed', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Withdraw access?')).not.toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
