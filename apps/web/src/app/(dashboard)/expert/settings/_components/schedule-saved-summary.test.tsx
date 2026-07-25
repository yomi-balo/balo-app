import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleSavedSummary } from './schedule-saved-summary';
import { createDefaultWeek, createEmptyWeek } from '../_lib/schedule-helpers';

describe('ScheduleSavedSummary', () => {
  it('renders a grouped text summary and the timezone', () => {
    render(<ScheduleSavedSummary week={createDefaultWeek()} timezone="Australia/Melbourne" />);
    expect(screen.getByText('Mon–Fri')).toBeInTheDocument();
    expect(screen.getByText(/9:00 AM – 5:00 PM/)).toBeInTheDocument();
    expect(screen.getByText(/Australia\/Melbourne/)).toBeInTheDocument();
  });

  it('handles a week with no bookable days', () => {
    render(<ScheduleSavedSummary week={createEmptyWeek()} timezone="Australia/Melbourne" />);
    expect(screen.getByText(/No days are currently open/i)).toBeInTheDocument();
  });
});
