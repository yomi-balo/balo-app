import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MoveCardContext as Context } from './move-card-context';
import type { ComponentProps } from 'react';
import type { ViewerClock } from '@/hooks/use-viewer-clock';

const SYDNEY: ViewerClock = {
  now: new Date('2026-10-20T10:00:00.000Z'),
  timeZone: 'Australia/Sydney',
};

/** Renders the context with the props every card passes; override per test. */
function MoveCardContext(
  props: Pick<ComponentProps<typeof Context>, 'context'> &
    Partial<Omit<ComponentProps<typeof Context>, 'context'>>
): React.JSX.Element {
  return <Context href="/cases/e-1" clock={null} onNavigate={() => undefined} {...props} />;
}

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
            { label: 'Your billing', state: 'done' },
            { label: 'Your payment', state: 'yours' },
            { label: 'Balo kickoff', state: 'pending' },
          ],
          note: null,
        }}
      />
    );
    const list = screen.getByRole('list', { name: 'Kickoff gates' });
    expect(list).toHaveTextContent('Your billing, done');
    expect(list).toHaveTextContent('Your payment, waiting on you');
    expect(list).toHaveTextContent('Balo kickoff, not yet');
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

  it('gates: renders the note under the steps only when set', () => {
    const gates = [{ label: 'Your billing', state: 'yours' as const }];
    const { rerender } = render(
      <MoveCardContext context={{ type: 'gates', gates, note: 'An owner confirms billing.' }} />
    );
    expect(screen.getByText('An owner confirms billing.')).toBeInTheDocument();
    rerender(<MoveCardContext context={{ type: 'gates', gates, note: null }} />);
    expect(screen.queryByText('An owner confirms billing.')).toBeNull();
  });

  it('stats: a labelled definition list', () => {
    render(
      <MoveCardContext
        context={{
          type: 'stats',
          stats: [
            { label: 'Version', value: '2' },
            { label: 'Timeframe', value: 'About 6 weeks' },
          ],
        }}
      />
    );
    expect(screen.getByText('Version').tagName).toBe('DT');
    expect(screen.getByText('About 6 weeks').tagName).toBe('DD');
  });

  it('reschedule: struck-through original and option links in the viewer zone', async () => {
    const onNavigate = vi.fn();
    render(
      <MoveCardContext
        clock={SYDNEY}
        onNavigate={onNavigate}
        context={{
          type: 'reschedule',
          wasIso: '2026-10-21T22:00:00.000Z',
          optionIsos: ['2026-10-22T09:00:00.000Z', '2026-10-23T04:30:00.000Z'],
        }}
      />
    );
    expect(screen.getByText('Was Thu 22 Oct, 9:00 am')).toHaveClass('line-through');
    const first = screen.getByRole('link', { name: 'Choose Thu 22 Oct, 8:00 pm on the case page' });
    expect(first).toHaveAttribute('href', '/cases/e-1');
    expect(first).toHaveClass('h-11');
    expect(
      screen.getByRole('link', { name: 'Choose Fri 23 Oct, 3:30 pm on the case page' })
    ).toBeInTheDocument();
    await userEvent.click(first);
    expect(onNavigate).toHaveBeenCalledWith('card');
  });

  it('reschedule: with no clock renders no date text and no links', () => {
    const { container } = render(
      <MoveCardContext
        context={{
          type: 'reschedule',
          wasIso: '2026-10-21T22:00:00.000Z',
          optionIsos: ['2026-10-22T09:00:00.000Z'],
        }}
      />
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('completion: progress, milestones line and the auto-accept day in the viewer zone', () => {
    render(
      <MoveCardContext
        clock={SYDNEY}
        context={{
          type: 'completion',
          done: 3,
          total: 4,
          autoAcceptIso: '2026-10-29T16:00:00.000Z',
        }}
      />
    );
    expect(screen.getByText('3 of 4 milestones complete')).toBeInTheDocument();
    expect(screen.getByText('Accepted automatically on Fri 30 Oct')).toBeInTheDocument();
  });

  it('completion: with no clock the auto-accept day is not rendered; a null deadline hides the line', () => {
    const { rerender } = render(
      <MoveCardContext
        context={{
          type: 'completion',
          done: 1,
          total: 2,
          autoAcceptIso: '2026-10-29T16:00:00.000Z',
        }}
      />
    );
    expect(screen.queryByText(/Accepted automatically/)).toBeNull();
    rerender(
      <MoveCardContext
        clock={SYDNEY}
        context={{ type: 'completion', done: 1, total: 2, autoAcceptIso: null }}
      />
    );
    expect(screen.queryByText(/Accepted automatically/)).toBeNull();
  });

  it('completion: a zero total does not divide by zero', () => {
    render(
      <MoveCardContext context={{ type: 'completion', done: 0, total: 0, autoAcceptIso: null }} />
    );
    expect(screen.getByText('0 of 0 milestones complete')).toBeInTheDocument();
  });

  it('people: initials, name, email and the overflow count', () => {
    render(
      <MoveCardContext
        context={{
          type: 'people',
          people: [
            { name: 'Riley Morgan', email: 'riley@northwind.example' },
            { name: 'Dana', email: 'dana@northwind.example' },
          ],
          more: 2,
        }}
      />
    );
    expect(screen.getByText('RM')).toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.getByText('riley@northwind.example')).toHaveClass('truncate');
    expect(screen.getByText('2 more')).toBeInTheDocument();
  });
});
