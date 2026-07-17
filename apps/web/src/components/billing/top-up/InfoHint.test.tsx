import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoHint } from './InfoHint';

describe('InfoHint', () => {
  it('renders a labelled, tappable trigger (never hover-only)', () => {
    render(<InfoHint text="An estimate at the average expert rate." label="Rate info" />);
    expect(screen.getByRole('button', { name: /Rate info/i })).toBeInTheDocument();
  });

  it('uses a default accessible label when none is provided', () => {
    render(<InfoHint text="Some help text." />);
    expect(screen.getByRole('button', { name: /More information/i })).toBeInTheDocument();
  });

  it('reveals the explanation text on tap (Popover, works on touch)', async () => {
    render(<InfoHint text="You are charged in AUD; your bank sets the rate." />);
    await userEvent.click(screen.getByRole('button', { name: /More information/i }));
    expect(await screen.findByText(/charged in AUD/i)).toBeInTheDocument();
  });
});
