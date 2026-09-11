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
    render(<HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" fellBack={false} />);
    expect(screen.getByLabelText('From (UTC)')).toHaveValue('2026-08-01');
    expect(screen.getByLabelText('To (UTC)')).toHaveValue('2026-08-31');
  });

  it('Apply pushes the new range, preserving other params (e.g. category)', () => {
    render(<HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" fellBack={false} />);
    screen.getByRole('button', { name: 'Apply' }).click();
    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    expect(url).toContain('category=recording');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('to=2026-08-31');
  });

  it('shows the fallback note when the window fell back', () => {
    render(<HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" fellBack={true} />);
    expect(screen.getByText(/showing the last 30 days instead/)).toBeInTheDocument();
  });

  it('shows no note when the window did not fall back', () => {
    render(<HealthWindowControl fromIso="2026-08-01" toIso="2026-08-31" fellBack={false} />);
    expect(screen.queryByText(/showing the last 30 days instead/)).not.toBeInTheDocument();
  });
});
