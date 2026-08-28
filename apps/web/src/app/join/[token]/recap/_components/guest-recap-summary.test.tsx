import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GuestRecapSummary } from './guest-recap-summary';
import type { GuestRecapSummaryView } from '../_lib/guest-recap-view-types';

function view(overrides: Partial<GuestRecapSummaryView> = {}): GuestRecapSummaryView {
  return { state: 'ready', content: 'A great call.', ...overrides };
}

describe('GuestRecapSummary', () => {
  it('renders the processing state in an <output>, never `role="status"` (SonarCloud S6819)', () => {
    const { container } = render(
      <GuestRecapSummary summary={view({ state: 'processing', content: null })} />
    );

    const output = container.querySelector('output');
    expect(output).not.toBeNull();
    expect(output?.getAttribute('role')).toBeNull();
    expect(screen.getByText(/usually takes a few minutes/i)).toBeInTheDocument();
  });

  it('renders the ready state with the content', () => {
    render(<GuestRecapSummary summary={view({ state: 'ready', content: 'A great call.' })} />);

    expect(screen.getByText('A great call.')).toBeInTheDocument();
  });

  it('⚠ never renders "Read full summary" — the member card`s expand/collapse has no equivalent here', () => {
    render(<GuestRecapSummary summary={view({ state: 'ready', content: 'A great call.' })} />);

    expect(screen.queryByRole('button', { name: /read full summary/i })).not.toBeInTheDocument();
  });

  it('renders the absent state with honest, actionable-free copy', () => {
    render(<GuestRecapSummary summary={view({ state: 'absent', content: null })} />);

    expect(screen.getByText("This call wasn't written up")).toBeInTheDocument();
    expect(
      screen.getByText("There's no summary for this one — anything that was shared is below.")
    ).toBeInTheDocument();
  });

  it('renders the failed state with COPY DISTINCT FROM absent', () => {
    render(<GuestRecapSummary summary={view({ state: 'failed', content: null })} />);

    expect(screen.getByText("We couldn't write this one up")).toBeInTheDocument();
    expect(screen.queryByText("This call wasn't written up")).not.toBeInTheDocument();
  });

  it('⚠ never leaks member-surface copy — no "action items", no "the transcript below"', () => {
    const states: readonly GuestRecapSummaryView[] = [
      { state: 'processing', content: null },
      { state: 'ready', content: 'Hello' },
      { state: 'absent', content: null },
      { state: 'failed', content: null },
    ];
    for (const summary of states) {
      const { unmount, container } = render(<GuestRecapSummary summary={summary} />);
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/action items/i);
      expect(text).not.toMatch(/transcript below/i);
      unmount();
    }
  });
});
