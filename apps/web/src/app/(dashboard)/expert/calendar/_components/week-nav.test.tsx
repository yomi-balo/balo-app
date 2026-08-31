import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import { WeekNav } from './week-nav';

describe('WeekNav', () => {
  it('Previous/Next call onNavigate with a week shifted by ±7 days', () => {
    const onNavigate = vi.fn();
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-08-24"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={onNavigate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(onNavigate).toHaveBeenCalledWith('2026-08-17');

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onNavigate).toHaveBeenCalledWith('2026-08-31');
  });

  it('renders the range label', () => {
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-08-24"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={vi.fn()}
      />
    );

    expect(screen.getByText('Aug 24 – 30, 2026')).toBeInTheDocument();
  });

  it('"Today" is aria-disabled (never `disabled`) and inert when the visible week contains today', () => {
    const onNavigate = vi.fn();
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-08-26"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={onNavigate}
      />
    );

    const todayButton = screen.getByRole('button', { name: 'Today' });
    expect(todayButton).toHaveAttribute('aria-disabled', 'true');
    expect(todayButton).not.toBeDisabled();

    fireEvent.click(todayButton);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('"Today" navigates to the week containing today when the visible week does not contain it', () => {
    const onNavigate = vi.fn();
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-09-10"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={onNavigate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenCalledWith('2026-09-07');
  });

  it('A4 — every control clears the 44px minimum tap target', () => {
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-08-26"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={vi.fn()}
      />
    );

    // Chevrons: `size="icon"` (36px) + 6px of transparent pseudo-element per side = 48px. They
    // were `size="icon-sm"` (32px). "Today" was `size="sm"` (32px tall).
    for (const label of ['Previous week', 'Next week']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.className).toContain('size-9');
      expect(button.className).toContain('after:-inset-1.5');
      expect(button.className).not.toContain('size-8');
    }
    expect(screen.getByRole('button', { name: 'Today' }).className).toContain('min-h-11');
  });

  it('the aria-disabled "Today" is still inert AND still 44px (the min-h-11 refactor kept both classes)', () => {
    const onNavigate = vi.fn();
    render(
      <WeekNav
        weekStartDayKey="2026-08-24"
        todayDayKey="2026-08-26"
        rangeLabel="Aug 24 – 30, 2026"
        onNavigate={onNavigate}
      />
    );

    const todayButton = screen.getByRole('button', { name: 'Today' });
    expect(todayButton.className).toContain('pointer-events-none');
    expect(todayButton.className).toContain('min-h-11');
    fireEvent.click(todayButton);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
