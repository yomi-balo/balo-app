import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// Mock motion to a plain div — framer-motion misbehaves in jsdom.
const MOTION_ONLY_PROPS = new Set(['whileHover', 'whileTap', 'transition', 'initial', 'animate']);
vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
  motion: new Proxy(
    {},
    {
      get: () => {
        return ({ children, ...props }: { children?: React.ReactNode }) => {
          // Strip motion-only props that React would warn about on a plain div.
          const rest = Object.fromEntries(
            Object.entries(props as Record<string, unknown>).filter(
              ([key]) => !MOTION_ONLY_PROPS.has(key)
            )
          );
          return <div {...rest}>{children}</div>;
        };
      },
    }
  ),
}));

const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

const { mockRegenerate, mockRefresh, mockReset } = vi.hoisted(() => ({
  mockRegenerate: vi.fn(),
  mockRefresh: vi.fn(),
  mockReset: vi.fn(),
}));
vi.mock('../_actions/seed', () => ({
  regenerateExpertsAction: mockRegenerate,
  refreshAvailabilityAction: mockRefresh,
  fullResetAction: mockReset,
}));

import { SeedPanel } from './seed-panel';

const REGEN_SUMMARY = {
  ok: true as const,
  expertsGenerated: 60,
  competenciesGenerated: 312,
  languagesGenerated: 90,
  industriesGenerated: 120,
  seedUsedRng: 20239,
  baselineAt: '2026-05-31T00:00:00.000Z',
};

describe('SeedPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three seeding cards under the section heading', () => {
    render(<SeedPanel />);
    expect(screen.getByText('Database Seeding')).toBeInTheDocument();
    expect(screen.getByText('Regenerate Experts')).toBeInTheDocument();
    expect(screen.getByText('Refresh Availability')).toBeInTheDocument();
    expect(screen.getByText('Full Reset')).toBeInTheDocument();
    // The single "Development Only" badge now lives in the page header
    // (de-duplicated), not inside SeedPanel.
    expect(screen.queryByText('Development Only')).not.toBeInTheDocument();
  });

  it('shows the idle empty state before any run', () => {
    render(<SeedPanel />);
    expect(screen.getAllByText('No run yet.').length).toBeGreaterThan(0);
  });

  it('updates the expert count input', () => {
    const { container } = render(<SeedPanel />);
    const input = container.querySelector<HTMLInputElement>('#seed-count')!;
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '150' } });
    expect(input).toHaveValue(150);
  });

  it('requires confirmation, then calls the regenerate action and shows the summary', async () => {
    mockRegenerate.mockResolvedValue({ success: true, data: REGEN_SUMMARY });
    const user = userEvent.setup();
    render(<SeedPanel />);

    // The action should NOT fire just by clicking the card button (opens dialog).
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(mockRegenerate).not.toHaveBeenCalled();

    // Confirm in the AlertDialog.
    const confirmButtons = await screen.findAllByRole('button', { name: 'Regenerate' });
    // The dialog action is the last "Regenerate" button rendered.
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(mockRegenerate).toHaveBeenCalledWith({ count: 60 }));
    // The success summary renders only after the AlertDialog (a Radix portal)
    // closes AND the startTransition that wraps the action resolves and commits
    // its low-priority state update. Under parallel CPU load those two async
    // boundaries can settle in separate ticks, so retry the full settled state
    // (summary value + toast) in one waitFor with a generous timeout instead of
    // racing a single findBy against the transition commit.
    await waitFor(
      () => {
        expect(screen.getByText('312')).toBeInTheDocument();
        expect(mockToast.success).toHaveBeenCalled();
      },
      { timeout: 5000 }
    );
  });

  it('renders an error state and error toast when the action fails', async () => {
    mockRegenerate.mockResolvedValue({ success: false, error: 'API unreachable' });
    const user = userEvent.setup();
    render(<SeedPanel />);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    const confirmButtons = await screen.findAllByRole('button', { name: 'Regenerate' });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    // Same portal-close + transition settling timing as the success case —
    // retry the full settled error state in one waitFor with a generous timeout.
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent('API unreachable');
        expect(mockToast.error).toHaveBeenCalledWith('Regenerate failed', {
          description: 'API unreachable',
        });
      },
      { timeout: 5000 }
    );
  });
});
