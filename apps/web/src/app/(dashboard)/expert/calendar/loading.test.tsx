import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import ExpertCalendarLoading from './loading';

describe('ExpertCalendarLoading', () => {
  it('renders the loading skeleton with an accessible name, no role="status" (S6819)', () => {
    render(<ExpertCalendarLoading />);

    expect(screen.getByRole('status', { name: 'Loading calendar' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
