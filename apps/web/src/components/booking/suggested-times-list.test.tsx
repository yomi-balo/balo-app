import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import { SuggestedTimesList, SuggestedTimesBackLink } from './suggested-times-list';

const SLOTS: AvailabilitySlotDto[] = [
  { start: '2026-09-02T09:00:00.000Z', end: '2026-09-02T09:30:00.000Z', maxDuration: 30 },
  { start: '2026-09-03T09:00:00.000Z', end: '2026-09-03T09:30:00.000Z', maxDuration: 30 },
];

describe('SuggestedTimesList', () => {
  it('renders one button per slot, each carrying its range and length', () => {
    render(
      <SuggestedTimesList slots={SLOTS} durationMinutes={30} onPick={vi.fn()} onSeeMore={vi.fn()} />
    );

    expect(screen.getByText(/Wed, 2 Sept, 9:00 – 9:30 am · 30 min/)).toBeInTheDocument();
    expect(screen.getByText(/Thu, 3 Sept, 9:00 – 9:30 am · 30 min/)).toBeInTheDocument();
  });

  it('picking a slot reports the SAME shape ExpertAvailabilityCalendar.onSlotSelect does', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <SuggestedTimesList slots={SLOTS} durationMinutes={30} onPick={onPick} onSeeMore={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /Wed, 2 Sept/ }));

    expect(onPick).toHaveBeenCalledWith({
      start: '2026-09-02T09:00:00.000Z',
      end: '2026-09-02T09:30:00.000Z',
      duration: 30,
    });
  });

  it('"See more times" fires onSeeMore', async () => {
    const onSeeMore = vi.fn();
    const user = userEvent.setup();
    render(
      <SuggestedTimesList
        slots={SLOTS}
        durationMinutes={30}
        onPick={vi.fn()}
        onSeeMore={onSeeMore}
      />
    );

    await user.click(screen.getByRole('button', { name: 'See more times' }));

    expect(onSeeMore).toHaveBeenCalledTimes(1);
  });

  it('adds={true} marks each button as adding, for a screen-reader user, without changing the visible label', () => {
    render(
      <SuggestedTimesList
        slots={SLOTS}
        durationMinutes={30}
        adds
        onPick={vi.fn()}
        onSeeMore={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: /Wed, 2 Sept.*— add/ });
    expect(button).toBeInTheDocument();
  });

  it('adds={false} (default) names no "add" affordance', () => {
    render(
      <SuggestedTimesList slots={SLOTS} durationMinutes={30} onPick={vi.fn()} onSeeMore={vi.fn()} />
    );

    expect(screen.queryByText(/— add/)).not.toBeInTheDocument();
  });
});

describe('SuggestedTimesBackLink', () => {
  it('fires onClick and is labelled "Suggested times"', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<SuggestedTimesBackLink onClick={onClick} />);

    await user.click(screen.getByRole('button', { name: 'Suggested times' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
