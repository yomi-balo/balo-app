import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { InboxEmptyState } from './inbox-empty-state';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe('InboxEmptyState', () => {
  it('renders the client invitation with a CTA that opens the request panel, not a link', () => {
    render(<InboxEmptyState lens="client" />);
    expect(screen.getByText('Start your first project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /raise a project request/i })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the expert invitation with a profile CTA', () => {
    render(<InboxEmptyState lens="expert" />);
    expect(screen.getByText('No project invitations yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review your expert profile/i })).toHaveAttribute(
      'href',
      '/expert/settings'
    );
  });

  it('renders the admin queue-clear state with no CTA', () => {
    render(<InboxEmptyState lens="admin" />);
    expect(screen.getByText(/queue clear/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
