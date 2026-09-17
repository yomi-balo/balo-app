import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { PLATFORM_CAPABILITIES, PLATFORM_CAPABILITY_LABELS } from '@balo/shared/authz';
import { CapabilityList } from './capability-list';

describe('CapabilityList', () => {
  it('shows the token id as secondary text alongside the human name', () => {
    render(
      <CapabilityList
        resolved={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        editable={false}
        lockOf={() => null}
        onToggle={vi.fn()}
      />
    );
    expect(
      screen.getByText(PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS].name)
    ).toBeInTheDocument();
    expect(screen.getByText(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS)).toBeInTheDocument();
  });

  it('renders the dev-only note for FAST_FORWARD_REQUEST', () => {
    render(
      <CapabilityList
        resolved={new Set()}
        editable={false}
        lockOf={() => null}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText(/only works in development/i)).toBeInTheDocument();
  });

  it('is read-only (checkbox disabled but visible) outside custom mode', () => {
    render(
      <CapabilityList
        resolved={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        editable={false}
        lockOf={() => null}
        onToggle={vi.fn()}
      />
    );
    const checkbox = screen.getByRole('checkbox', {
      name: new RegExp(
        PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS].name,
        'i'
      ),
    });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('data-state', 'checked');
  });

  it('calls onToggle when an editable, unlocked row is clicked', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <CapabilityList resolved={new Set()} editable lockOf={() => null} onToggle={onToggle} />
    );
    const checkbox = screen.getByRole('checkbox', {
      name: new RegExp(
        PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS].name,
        'i'
      ),
    });
    await user.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS);
  });

  it('shows the floor lock copy and does not call onToggle when clicked', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <CapabilityList
        resolved={new Set([PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES])}
        editable
        lockOf={(capability) =>
          capability === PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES ? 'floor' : null
        }
        onToggle={onToggle}
      />
    );
    expect(
      screen.getByText(/leaves no one able to open this page and manage staff/i)
    ).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', {
      name: new RegExp(
        PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES].name,
        'i'
      ),
    });
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the super-admin-only lock copy for a token an admin cannot hold', () => {
    render(
      <CapabilityList
        resolved={new Set()}
        editable
        lockOf={(capability) =>
          capability === PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES ? 'super_admin_only' : null
        }
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText(/only a super admin can hold this/i)).toBeInTheDocument();
  });
});
