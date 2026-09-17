import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { StaffAccessEmptyState, StaffAccessNoAccess } from './staff-access-states';

describe('StaffAccessEmptyState', () => {
  it('renders invitation copy, not absence-framed', () => {
    render(<StaffAccessEmptyState onGiveAccess={vi.fn()} />);
    expect(screen.getByText('Give someone staff access')).toBeInTheDocument();
    expect(screen.queryByText(/no one/i)).not.toBeInTheDocument();
  });

  it('calls onGiveAccess when the CTA is clicked', async () => {
    const user = userEvent.setup();
    const onGiveAccess = vi.fn();
    render(<StaffAccessEmptyState onGiveAccess={onGiveAccess} />);
    await user.click(screen.getByRole('button', { name: /give someone access/i }));
    expect(onGiveAccess).toHaveBeenCalledTimes(1);
  });
});

describe('StaffAccessNoAccess', () => {
  it('renders the no-access copy', () => {
    render(<StaffAccessNoAccess />);
    expect(screen.getByText('Only people who manage staff can open this page')).toBeInTheDocument();
    expect(screen.getByText(/ask a super admin/i)).toBeInTheDocument();
  });
});
