import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', () => {
  const MOTION_PROPS = new Set([
    'variants',
    'initial',
    'animate',
    'exit',
    'whileHover',
    'whileTap',
    'transition',
  ]);
  const filterMotion = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)));

  return {
    motion: {
      div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div {...filterMotion(props)}>{children}</div>
      ),
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
    // BAL-397 fix round — the disclosure's Motion animation is now gated on the hook (plan §7:
    // the global `prefers-reduced-motion` CSS block covers CSS animations only, so a JS/Motion
    // animation needs this). Reduced by default here, matching every other calendar test.
    useReducedMotion: () => true,
  };
});

import { CalendarSyncPendingNotice } from './calendar-sync-pending-notice';

describe('CalendarSyncPendingNotice', () => {
  it('renders the corrected copy — provisioning, not "some permissions weren\'t granted"', () => {
    render(<CalendarSyncPendingNotice provider="google" onFixPermissions={vi.fn()} />);
    expect(screen.getByText("We're still setting up this calendar")).toBeInTheDocument();
    expect(screen.queryByText(/some permissions weren't granted/i)).not.toBeInTheDocument();
  });

  it('renders the "Fix permissions" button', () => {
    render(<CalendarSyncPendingNotice provider="google" onFixPermissions={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Fix permissions/i })).toBeInTheDocument();
  });

  it('calls onFixPermissions when button is clicked', async () => {
    const user = userEvent.setup();
    const mockOnFix = vi.fn();
    render(<CalendarSyncPendingNotice provider="google" onFixPermissions={mockOnFix} />);

    await user.click(screen.getByRole('button', { name: /Fix permissions/i }));
    expect(mockOnFix).toHaveBeenCalledOnce();
  });

  it('toggles the "Why did this happen?" disclosure, showing the Google revoke hint', async () => {
    const user = userEvent.setup();
    render(<CalendarSyncPendingNotice provider="google" onFixPermissions={vi.fn()} />);

    const toggleBtn = screen.getByRole('button', { name: /Why did this happen/i });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/myaccount\.google\.com\/permissions/)).toBeInTheDocument();

    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('omits the Google-specific revoke hint for microsoft', async () => {
    const user = userEvent.setup();
    render(<CalendarSyncPendingNotice provider="microsoft" onFixPermissions={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Why did this happen/i }));
    expect(screen.queryByText(/myaccount\.google\.com/)).not.toBeInTheDocument();
  });

  it('renders the self-healing note', () => {
    render(<CalendarSyncPendingNotice provider="google" onFixPermissions={vi.fn()} />);
    expect(screen.getByText(/your calendar will sync automatically/i)).toBeInTheDocument();
  });
});
