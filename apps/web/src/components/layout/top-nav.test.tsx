import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

// Mock NotificationBell to avoid fetch calls
vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

import { TopNav } from './top-nav';

// ── Tests ───────────────────────────────────────────────────────

describe('TopNav', () => {
  it('renders the breadcrumb trail for the pathname', () => {
    render(<TopNav />);
    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders the NotificationBell component', () => {
    render(<TopNav />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
  });

  it('bare <TopNav /> renders no credits chip at all (D2 — no client-side re-decision)', () => {
    render(<TopNav />);
    expect(screen.queryByRole('link', { name: /credits/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('A$');
  });

  it('renders a supplied creditsChip before the notification bell (D9 — bell stays right-most)', () => {
    render(<TopNav creditsChip={<div data-testid="chip-stub">chip</div>} />);

    const chip = screen.getByTestId('chip-stub');
    const bell = screen.getByTestId('notification-bell');
    expect(chip).toBeInTheDocument();
    // chip precedes bell ⇒ bell FOLLOWS chip in document order.
    expect(chip.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('BAL-499 F7: the chip renders with NO wrapper element around it — its own parent is the flex row', () => {
    render(<TopNav creditsChip={<div data-testid="chip-stub">chip</div>} />);

    const chip = screen.getByTestId('chip-stub');
    // A wrapper `<div>` (even a classless one) would still be a flex item contributing to the
    // row's `gap-3`, even when the chip inside it is `null` (the slot's error path) or
    // CSS-hidden below `sm`. The chip's parentElement must be the row itself, not an
    // intermediate wrapper.
    const row = screen.getByRole('banner').firstElementChild;
    expect(chip.parentElement).toBe(row);
  });
});
