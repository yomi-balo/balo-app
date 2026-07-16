import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share', () => ({
  shareProposalWithColleague: vi.fn(),
  revokeProposalShareLink: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ShareMenu } from './share-menu';

function renderMenu(): void {
  render(<ShareMenu requestId="req-1" relationshipId="rel-1" version={3} />);
}

describe('ShareMenu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the dropdown with both items and a versioned download link', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Share/ }));

    const download = await screen.findByRole('menuitem', { name: /Download PDF/ });
    expect(download).toHaveAttribute('href', '/projects/req-1/proposal/rel-1/pdf');
    expect(screen.getByText(/The proposal as a file \(v3\)/)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Share with a colleague/ })).toBeInTheDocument();
  });

  it('opens the share modal from the "Share with a colleague" item', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Share/ }));
    await user.click(screen.getByRole('menuitem', { name: /Share with a colleague/ }));

    await waitFor(() => expect(screen.getByText('Share this proposal')).toBeInTheDocument());
  });
});
