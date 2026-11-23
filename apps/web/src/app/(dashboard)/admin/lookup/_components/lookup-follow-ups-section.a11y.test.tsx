import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { render, screen } from '@/test/utils';
import type { FollowUpWaitView, LookupFollowUpsView } from '../_lib/follow-ups-view';
import { LookupFollowUpsSection } from './lookup-follow-ups-section';

/**
 * BAL-666 — automated a11y coverage for the Follow-ups tab's states: loaded (closed and open),
 * empty, error. Follows `lookup-timeline-section.a11y.test.tsx`.
 */

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock('../_actions/fetch-lookup-follow-ups', () => ({
  fetchLookupFollowUpsAction: mockAction,
}));

function wait(id: string, state: FollowUpWaitView['state']): FollowUpWaitView {
  return {
    id,
    title: 'Proposals to review',
    headline: `Request ${id}`,
    context: ['Project request', '2 proposals', 'waiting since Mon 16 Nov'],
    state,
    summary: '1 of 3 sent · 1 failed',
    note: null,
    hasFailed: true,
    steps: [
      {
        key: 'day_2',
        ordinal: '1st',
        offsetLabel: '2 days after',
        state: 'sent',
        channel: 'Email',
        sentence: null,
        code: null,
        detail: null,
        held: null,
        whenLabel: 'Wed 18 Nov, 9:00 am',
      },
      {
        key: 'day_5',
        ordinal: '2nd',
        offsetLabel: '5 days after',
        state: 'failed',
        channel: null,
        sentence: 'It could not be sent after 3 attempts.',
        code: 'status = failed',
        detail: 'Rejected. Also on admin Home.',
        held: 'Fell due on Saturday. Held to Monday morning.',
        whenLabel: 'Mon 23 Nov, 9:00 am',
      },
      {
        key: 'day_9',
        ordinal: '3rd',
        offsetLabel: '9 days after',
        state: 'due',
        channel: null,
        sentence: null,
        code: null,
        detail: null,
        held: null,
        whenLabel: 'Wed 25 Nov, 9:00 am',
      },
    ],
  };
}

function view(over: Partial<LookupFollowUpsView> = {}): LookupFollowUpsView {
  return {
    lens: 'person',
    subjectFirstName: 'Dana',
    origin: null,
    limit: { used: 2, of: 2, full: true },
    now: [wait('a', 'waiting'), wait('b', 'finished')],
    earlier: [wait('c', 'stopped')],
    ...over,
  };
}

describe('LookupFollowUpsSection — accessibility', () => {
  it('has no violations when loaded with every block closed', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view() });
    const { container } = render(<LookupFollowUpsSection entityType="user" entityId="u1" />);
    await screen.findByText('Waiting now · 2');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with every block open', async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: true, view: view() });
    const { container } = render(<LookupFollowUpsSection entityType="user" entityId="u1" />);
    await user.click(await screen.findByRole('button', { name: 'Expand all' }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the empty state', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view({ now: [], earlier: [], limit: null }) });
    const { container } = render(<LookupFollowUpsSection entityType="user" entityId="u1" />);
    await screen.findByText('Nothing is waiting on Dana');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the error state', async () => {
    mockAction.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { container } = render(<LookupFollowUpsSection entityType="user" entityId="u1" />);
    await screen.findByText('Follow-ups could not be loaded');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations while loading', async () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    const { container } = render(<LookupFollowUpsSection entityType="user" entityId="u1" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
