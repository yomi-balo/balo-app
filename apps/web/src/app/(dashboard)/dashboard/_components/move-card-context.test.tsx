import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { MoveCardContext } from './move-card-context';

describe('MoveCardContext', () => {
  it('brief: excerpt, tags and timeline', () => {
    render(
      <MoveCardContext
        context={{
          type: 'brief',
          excerpt: 'Migrate to Sales Cloud',
          tags: ['CPQ', 'Flow'],
          timeline: '6 weeks',
        }}
      />
    );
    expect(screen.getByText('Migrate to Sales Cloud')).toHaveClass('line-clamp-3');
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('6 weeks')).toBeInTheDocument();
  });

  it('brief: renders no empty excerpt or timeline', () => {
    const { container } = render(
      <MoveCardContext context={{ type: 'brief', excerpt: null, tags: [], timeline: null }} />
    );
    expect(container.querySelector('p')).toBeNull();
  });

  it('sentence and draft render their text', () => {
    const { rerender } = render(
      <MoveCardContext context={{ type: 'sentence', body: 'Share times' }} />
    );
    expect(screen.getByText('Share times')).toBeInTheDocument();
    rerender(<MoveCardContext context={{ type: 'draft', label: 'Not started yet' }} />);
    expect(screen.getByText('Not started yet')).toBeInTheDocument();
  });

  it('message: company, time and a two-line snippet', () => {
    render(
      <MoveCardContext
        context={{ type: 'message', from: 'Northwind', at: '2h ago', snippet: 'Can we talk?' }}
      />
    );
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getByText('Can we talk?')).toHaveClass('line-clamp-2');
  });

  it('message: omits a null time', () => {
    render(
      <MoveCardContext context={{ type: 'message', from: 'Northwind', at: null, snippet: 'Hi' }} />
    );
    expect(screen.queryByText('2h ago')).toBeNull();
  });

  it('change_note: three-line note with the single section chip, or none for general', () => {
    const { rerender } = render(
      <MoveCardContext
        context={{ type: 'change_note', note: 'Tighten scope', section: 'Pricing' }}
      />
    );
    expect(screen.getByText('Tighten scope')).toHaveClass('line-clamp-3');
    expect(screen.getByText('Pricing')).toBeInTheDocument();
    rerender(
      <MoveCardContext context={{ type: 'change_note', note: 'Tighten scope', section: null }} />
    );
    expect(screen.queryByText('Pricing')).toBeNull();
  });

  it('gates: announces each state to assistive tech', () => {
    render(
      <MoveCardContext
        context={{
          type: 'gates',
          gates: [
            { label: 'Client billing', state: 'done' },
            { label: 'Your terms', state: 'yours' },
            { label: 'Balo approval', state: 'pending' },
          ],
        }}
      />
    );
    const list = screen.getByRole('list', { name: 'Kickoff gates' });
    expect(list).toHaveTextContent('Client billing, done');
    expect(list).toHaveTextContent('Your terms, waiting on you');
    expect(list).toHaveTextContent('Balo approval, not yet');
  });

  it('delivery: note, progress and milestone count', () => {
    render(
      <MoveCardContext context={{ type: 'delivery', note: 'Rework the flow', done: 2, total: 5 }} />
    );
    expect(screen.getByText('Rework the flow')).toBeInTheDocument();
    expect(screen.getByText('2 of 5 milestones')).toBeInTheDocument();
  });

  it('delivery: a zero total does not divide by zero', () => {
    render(<MoveCardContext context={{ type: 'delivery', note: 'n', done: 0, total: 0 }} />);
    expect(screen.getByText('0 of 0 milestones')).toBeInTheDocument();
  });

  it('items: flags overdue items and shows the overflow count', () => {
    render(
      <MoveCardContext
        context={{
          type: 'items',
          items: [
            { text: 'Send SOW', overdue: true },
            { text: 'Book demo', overdue: false },
          ],
          more: 3,
        }}
      />
    );
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Send SOW')).toBeInTheDocument();
    expect(screen.getByText('3 more')).toBeInTheDocument();
  });

  it('items: no overflow line when nothing is hidden', () => {
    render(
      <MoveCardContext
        context={{ type: 'items', items: [{ text: 'A', overdue: false }], more: 0 }}
      />
    );
    expect(screen.queryByText(/more/)).toBeNull();
  });
});
