import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

import { ApplicationList } from './application-list';
import type { ApplicationListRowView } from '../_lib/application-list-view';

const COUNTS = { pending: 1, approved: 0, declined: 0 };

function row(overrides: Partial<ApplicationListRowView> = {}): ApplicationListRowView {
  return {
    expertProfileId: 'p1',
    name: 'Priya Shah',
    email: 'priya@example.com',
    agencyLabel: 'Independent',
    statusLine: 'waiting 6d',
    daysWaiting: 6,
    ...overrides,
  };
}

describe('ApplicationList', () => {
  it('the pending empty state is invitation-framed, not absence-framed', () => {
    render(<ApplicationList filter="pending" rows={[]} counts={COUNTS} truncated={false} />);
    expect(
      screen.getByText(/new applications land here the moment an expert submits/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/no applications yet/i)).toBeNull();
  });

  it('the decided empty state is softened, not absence-framed', () => {
    render(
      <ApplicationList
        filter="approved"
        rows={[]}
        counts={{ ...COUNTS, approved: 0 }}
        truncated={false}
      />
    );
    expect(screen.getByText('Nothing decided in the last 30 days')).toBeInTheDocument();
    // FIX ROUND F7 — the absence framing this replaced must not come back.
    expect(screen.queryByText(/no decisions in the last 30 days/i)).toBeNull();
  });

  /**
   * FIX ROUND F17 — on a zero-count decided filter, `ApplicationFilterChips` disables every
   * other chip, so this link is the ONLY route back to Pending.
   *
   * MUTATION: delete the `Show pending applications` link from `DecidedEmpty` → red.
   */
  it('the decided empty state offers a route back to Pending', () => {
    render(
      <ApplicationList
        filter="declined"
        rows={[]}
        counts={{ pending: 0, approved: 0, declined: 0 }}
        truncated={false}
      />
    );
    expect(screen.getByRole('link', { name: /show pending applications/i })).toHaveAttribute(
      'href',
      '/admin/applications?filter=pending'
    );
  });

  it('renders each row with name, agency, email and status line, linking to the review page', () => {
    render(
      <ApplicationList
        filter="pending"
        rows={[
          row(),
          row({
            expertProfileId: 'p2',
            name: 'Dana K',
            email: 'dana@example.com',
            agencyLabel: 'CloudPeak',
            statusLine: 'waiting 2d',
            daysWaiting: 2,
          }),
        ]}
        counts={{ ...COUNTS, pending: 2 }}
        truncated={false}
      />
    );
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.getByText('priya@example.com')).toBeInTheDocument();
    expect(screen.getByText('waiting 6d')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /priya shah/i })).toHaveAttribute(
      'href',
      '/admin/applications/p1'
    );
    expect(screen.getByText('CloudPeak')).toBeInTheDocument();
  });

  /**
   * FIX ROUND F19 — the three filters are DISJOINT, so the old "narrow the filter to see more"
   * named an action that reveals nothing. Each arm now describes its own batch.
   *
   * MUTATION: collapse the two arms back to one shared "narrow the filter" line → both red.
   */
  it('the pending truncation notice names the ordering, not a filter that reveals nothing', () => {
    render(<ApplicationList filter="pending" rows={[row()]} counts={COUNTS} truncated />);
    expect(
      screen.getByText('Showing the oldest 1 — decide some to see the rest.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/narrow the filter/i)).toBeNull();
  });

  it('the decided truncation notice says the batch is the most recent', () => {
    render(
      <ApplicationList
        filter="declined"
        rows={[row()]}
        counts={{ ...COUNTS, declined: 1 }}
        truncated
      />
    );
    expect(
      screen.getByText('Showing the 1 most recent — older decisions are not listed.')
    ).toBeInTheDocument();
  });

  it('does not show a truncated notice when the batch did not fill', () => {
    render(<ApplicationList filter="pending" rows={[row()]} counts={COUNTS} truncated={false} />);
    expect(screen.queryByText(/showing the/i)).toBeNull();
  });
});
