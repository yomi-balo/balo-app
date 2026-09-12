import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { HealthWindowControl } from './health-window-control';

const { mockPush, mockSearchParams } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockSearchParams: { toString: () => 'category=recording' },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

describe('HealthWindowControl', () => {
  it('renders the current from/to values', () => {
    render(
      <HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" days={31} fellBack={false} />
    );
    expect(screen.getByLabelText('From (UTC)')).toHaveValue('2026-08-01');
    expect(screen.getByLabelText('To (UTC)')).toHaveValue('2026-08-31');
  });

  it('Apply pushes the new range, preserving other params (e.g. category)', () => {
    render(
      <HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" days={31} fellBack={false} />
    );
    screen.getByRole('button', { name: 'Apply' }).click();
    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    expect(url).toContain('category=recording');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('to=2026-08-31');
  });

  /**
   * The note must report the window that was ACTUALLY resolved. The two fall-back paths differ:
   * an invalid range falls back to the default 30 days, while an over-cap range is clamped to the
   * maximum span ending at the date that was asked for — so a hard-coded "last 30 days" told the
   * over-cap user a range the rows below did not come from.
   */
  it('the fallback note names the resolved span and end date, not a hard-coded 30 days', () => {
    render(<HealthWindowControl fromIso="2026-03-16" toIso="2026-09-11" days={180} fellBack />);
    expect(screen.getByText(/showing 180 days ending 2026-09-11 instead/)).toBeInTheDocument();
    expect(screen.queryByText(/last 30 days/)).not.toBeInTheDocument();
  });

  it('the default-window fall-back reports its own 30 days', () => {
    render(<HealthWindowControl fromIso="2026-08-12" toIso="2026-09-11" days={30} fellBack />);
    expect(screen.getByText(/showing 30 days ending 2026-09-11 instead/)).toBeInTheDocument();
  });

  it('shows no note when the window did not fall back', () => {
    render(
      <HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" days={31} fellBack={false} />
    );
    expect(screen.queryByText(/instead/)).not.toBeInTheDocument();
  });
});
