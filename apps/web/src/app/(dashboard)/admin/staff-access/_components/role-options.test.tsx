import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { STAFF_ACCESS_ROLE_ORDER } from '../_lib/staff-access-roles';
import { RoleOptions } from './role-options';

describe('RoleOptions', () => {
  it('renders one radio per role, with the current value checked', () => {
    render(
      <RoleOptions
        roles={STAFF_ACCESS_ROLE_ORDER}
        value="admin"
        onSelect={vi.fn()}
        disabledReason={() => null}
      />
    );
    const group = screen.getByRole('radiogroup', { name: 'Role' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /^admin/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /super admin/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('calls onSelect with the clicked role', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <RoleOptions
        roles={STAFF_ACCESS_ROLE_ORDER}
        value="user"
        onSelect={onSelect}
        disabledReason={() => null}
      />
    );
    await user.click(screen.getByRole('radio', { name: /super admin/i }));
    expect(onSelect).toHaveBeenCalledWith('super_admin');
  });

  it('shows a blocked reason as visible text, and disables that option', () => {
    render(
      <RoleOptions
        roles={STAFF_ACCESS_ROLE_ORDER}
        value="super_admin"
        onSelect={vi.fn()}
        disabledReason={(role) =>
          role === 'admin' ? 'Give someone else that access first.' : null
        }
      />
    );
    expect(screen.getByText('Give someone else that access first.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^admin/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /super admin/i })).not.toBeDisabled();
  });

  it('the `disabled` prop blocks every option regardless of disabledReason', () => {
    render(
      <RoleOptions
        roles={STAFF_ACCESS_ROLE_ORDER}
        value="admin"
        onSelect={vi.fn()}
        disabledReason={() => null}
        disabled
      />
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
  });
});
