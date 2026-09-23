import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarRowHeader } from './calendar-row-header';

describe('CalendarRowHeader', () => {
  it('renders the provider label as the row heading and the subline beneath it', () => {
    render(<CalendarRowHeader provider="microsoft" subline="dana@example.com" />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Microsoft Outlook' })
    ).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
  });

  it('renders the brand icon decoratively', () => {
    const { container } = render(<CalendarRowHeader provider="google" subline="x" />);
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders trailing controls only when given', () => {
    const { rerender } = render(<CalendarRowHeader provider="google" subline="x" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <CalendarRowHeader provider="google" subline="x">
        <button type="button">Act</button>
      </CalendarRowHeader>
    );
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });
});
