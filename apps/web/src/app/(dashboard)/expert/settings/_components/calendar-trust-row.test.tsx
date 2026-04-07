import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarTrustRow } from './calendar-trust-row';

describe('CalendarTrustRow', () => {
  it('renders all three trust items', () => {
    render(<CalendarTrustRow />);

    expect(screen.getByText('We only read your event times')).toBeInTheDocument();
    expect(screen.getByText('Details never shared with clients')).toBeInTheDocument();
    expect(screen.getByText('Syncs every 5 minutes')).toBeInTheDocument();
  });

  it('renders three icon elements with aria-hidden', () => {
    const { container } = render(<CalendarTrustRow />);
    const hiddenIcons = container.querySelectorAll('[aria-hidden="true"]');
    expect(hiddenIcons).toHaveLength(3);
  });
});
