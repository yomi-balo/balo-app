import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { QueueEmpty, QueueFilteredEmpty } from './queue-empty-states';

describe('QueueEmpty (true-zero)', () => {
  it('leads with the invitation-framed heading and links to the catalogue', () => {
    render(<QueueEmpty />);
    expect(screen.getByText('Nothing needs a person right now')).toBeInTheDocument();
    expect(screen.getByText(/New ones land here the moment a sweep finds one/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open config & catalogue/ })).toHaveAttribute(
      'href',
      '/admin/catalogue'
    );
  });
});

describe('QueueFilteredEmpty', () => {
  it('frames the group hint as a good outcome and offers Back to all', () => {
    render(<QueueFilteredEmpty groupLabel="Money" groupHint="Receivables, reloads, disputes" />);
    expect(screen.getByText('Nothing open in money')).toBeInTheDocument();
    expect(screen.getByText(/Receivables, reloads, disputes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all' })).toHaveAttribute('href', '/admin');
  });
});
