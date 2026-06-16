import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { InboxEmptyState } from './inbox-empty-state';

describe('InboxEmptyState', () => {
  it('renders the client invitation with a request CTA pointing at /experts', () => {
    render(<InboxEmptyState lens="client" />);
    expect(screen.getByText('Start your first project')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /raise a project request/i })).toHaveAttribute(
      'href',
      '/experts'
    );
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
