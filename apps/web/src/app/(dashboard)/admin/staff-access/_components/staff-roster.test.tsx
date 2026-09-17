import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { StaffAccessPerson } from '@balo/shared/authz';
import { StaffRoster } from './staff-roster';

const PEOPLE: readonly StaffAccessPerson[] = [
  {
    id: 'u1',
    firstName: 'Dana',
    lastName: 'Whitfield',
    email: 'dana@example.com',
    role: 'super_admin',
    customList: null,
    isLive: true,
    emailVerified: true,
  },
  {
    id: 'u2',
    firstName: 'Adeeb',
    lastName: 'Rahman',
    email: 'adeeb@example.com',
    role: 'admin',
    customList: ['manage_promo_codes'] as never,
    isLive: false,
    emailVerified: true,
  },
];

function renderRoster(overrides: Partial<React.ComponentProps<typeof StaffRoster>> = {}) {
  return render(
    <StaffRoster
      people={PEOPLE}
      query=""
      onQueryChange={vi.fn()}
      activePersonId={null}
      onSelect={vi.fn()}
      viewerId="u1"
      onGiveAccess={vi.fn()}
      {...overrides}
    />
  );
}

describe('StaffRoster', () => {
  it('renders every person with their meta line, marking custom and suspended', () => {
    renderRoster();
    expect(screen.getByText('Dana Whitfield (you)')).toBeInTheDocument();
    expect(screen.getByText('Adeeb Rahman')).toBeInTheDocument();
    expect(screen.getByText('Super admin')).toBeInTheDocument();
    expect(screen.getByText('Admin · custom · suspended')).toBeInTheDocument();
  });

  it('shows the footer count', () => {
    renderRoster();
    expect(screen.getByText('2 with staff access')).toBeInTheDocument();
  });

  it('calls onSelect when a roster item is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRoster({ onSelect });
    await user.click(screen.getByText('Adeeb Rahman'));
    expect(onSelect).toHaveBeenCalledWith('u2');
  });

  it('marks the active item with aria-current', () => {
    renderRoster({ activePersonId: 'u2' });
    const activeButton = screen.getByText('Adeeb Rahman').closest('button');
    expect(activeButton).toHaveAttribute('aria-current', 'true');
  });

  it('filters case-insensitively on name and email, and shows an invitation empty state', () => {
    renderRoster({ query: 'ZZZ-no-match' });
    expect(screen.getByText(/nobody on the list matches/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /give someone access/i }).length).toBeGreaterThan(
      0
    );
  });

  it('a query matching an email filters to that person', () => {
    renderRoster({ query: 'adeeb@example.com' });
    expect(screen.getByText('Adeeb Rahman')).toBeInTheDocument();
    expect(screen.queryByText('Dana Whitfield (you)')).not.toBeInTheDocument();
  });

  it('calls onGiveAccess from the footer link', async () => {
    const user = userEvent.setup();
    const onGiveAccess = vi.fn();
    renderRoster({ onGiveAccess });
    await user.click(screen.getByRole('button', { name: 'Give someone access' }));
    expect(onGiveAccess).toHaveBeenCalledTimes(1);
  });
});
