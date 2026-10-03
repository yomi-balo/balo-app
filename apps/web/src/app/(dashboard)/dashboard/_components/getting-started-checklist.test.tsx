import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { expertSettingsHrefFor } from '@/lib/constants/expert-checklist';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { GettingStartedChecklist } from './getting-started-checklist';

function status(overrides: Partial<ChecklistStatus> = {}): ChecklistStatus {
  return {
    items: {
      profile: true,
      phone: true,
      rate: true,
      calendar: true,
      availability: true,
      payouts: false,
    },
    completedCount: 4,
    allComplete: false,
    rateCents: 313,
    calendarNeedsReconnect: false,
    availableForWork: true,
    ...overrides,
  };
}

describe('GettingStartedChecklist', () => {
  it('shows the availability row as normal while available', () => {
    render(<GettingStartedChecklist status={status()} />);

    expect(screen.getByText('Set your availability')).toBeInTheDocument();
    expect(screen.getByText("Tell clients when you're free")).toBeInTheDocument();
    expect(screen.queryByText('Paused for new work')).not.toBeInTheDocument();
  });

  it('reads the availability row as paused, pointing at Schedule, when paused', async () => {
    const user = userEvent.setup();
    render(<GettingStartedChecklist status={status({ availableForWork: false })} />);

    expect(screen.getByText('Paused for new work')).toBeInTheDocument();
    expect(screen.getByText('Turn availability back on in Schedule')).toBeInTheDocument();
    expect(screen.queryByText('Set your availability')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Paused for new work/ }));
    expect(mockPush).toHaveBeenCalledWith(expertSettingsHrefFor('availability'));
  });

  it('leaves the other rows and the completion count untouched while paused', () => {
    render(<GettingStartedChecklist status={status({ availableForWork: false })} />);

    expect(screen.getByText('4/5')).toBeInTheDocument();
    expect(screen.getByText('Complete your profile')).toBeInTheDocument();
    expect(screen.getByText('Set up payouts')).toBeInTheDocument();
  });

  it('renders the paused row as its own state: no strike-through, no Done, a Paused badge', () => {
    render(<GettingStartedChecklist status={status({ availableForWork: false })} />);

    const row = screen.getByRole('button', { name: /Paused for new work/ });
    expect(row).toHaveTextContent('Paused');
    expect(row).not.toHaveTextContent('Done');
    expect(screen.getByText('Paused for new work')).not.toHaveClass('line-through');
  });

  it('does not number the paused row and numbers the remaining to-do rows without a gap', () => {
    render(
      <GettingStartedChecklist
        status={status({
          availableForWork: false,
          items: {
            profile: false,
            phone: true,
            rate: true,
            calendar: true,
            availability: false,
            payouts: false,
          },
          completedCount: 2,
        })}
      />
    );

    const pausedRow = screen.getByRole('button', { name: /Paused for new work/ });
    expect(pausedRow).not.toHaveTextContent(/^\d/);
    expect(screen.getByRole('button', { name: /Complete your profile/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Set up payouts/ })).toHaveTextContent('2');
  });
});
