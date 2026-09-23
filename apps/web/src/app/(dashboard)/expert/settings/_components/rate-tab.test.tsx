import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RateTab } from './rate-tab';

vi.mock('../_actions/save-rate', () => ({ saveRateAction: vi.fn() }));

describe('RateTab — header', () => {
  it('opens with the shared settings header: icon left of the title, not a centred hero', () => {
    const { container } = render(<RateTab initialRateCents={250} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Set Your Rate' });
    expect(
      screen.getByText(/This is your take-home amount per minute/).closest('div')
    ).toContainElement(heading);
    expect(heading.closest('.text-center')).toBeNull();

    const header = heading.closest('.items-start');
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.mx-auto')).toBeNull();
  });
});
