import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { LocalDate } from './local-date';

describe('LocalDate', () => {
  it('renders a <time> with the viewer-local short date and a machine-readable dateTime', () => {
    render(<LocalDate iso="2026-06-19T09:00:00.000Z" />);
    const el = screen.getByText('19 Jun');
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveAttribute('datetime', '2026-06-19T09:00:00.000Z');
  });

  it('forwards a className', () => {
    render(<LocalDate iso="2026-06-19T09:00:00.000Z" className="text-warning" />);
    expect(screen.getByText('19 Jun')).toHaveClass('text-warning');
  });
});
