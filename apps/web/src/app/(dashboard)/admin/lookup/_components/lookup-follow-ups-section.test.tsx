import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type {
  FollowUpStepView,
  FollowUpWaitView,
  LookupFollowUpsView,
} from '../_lib/follow-ups-view';
import { LookupFollowUpsSection } from './lookup-follow-ups-section';

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock('../_actions/fetch-lookup-follow-ups', () => ({
  fetchLookupFollowUpsAction: mockAction,
}));

const STATE_WORD: Readonly<Record<FollowUpStepView['state'], string>> = {
  sent: 'Sent',
  due: 'Due',
  not_sent: 'Not sent',
  failed: 'Failed',
};

function step(over: Partial<FollowUpStepView> = {}): FollowUpStepView {
  return {
    key: 'day_2',
    ordinal: '1st',
    offsetLabel: '2 days after',
    state: 'sent',
    label: STATE_WORD[over.state ?? 'sent'],
    channel: 'Email',
    delivery: [],
    sentence: null,
    code: null,
    detail: null,
    held: null,
    whenLabel: 'Wed 18 Nov, 9:00 am',
    ...over,
  };
}

function wait(id: string, over: Partial<FollowUpWaitView> = {}): FollowUpWaitView {
  return {
    id,
    title: 'Proposals to review',
    headline: `Request ${id}`,
    context: ['Project request', '2 proposals', 'waiting since Mon 16 Nov'],
    state: 'waiting',
    summary: '1 of 3 sent · next Wed 25 Nov, 9:00 am',
    note: null,
    hasFailed: false,
    steps: [
      step(),
      step({
        key: 'day_5',
        ordinal: '2nd',
        offsetLabel: '5 days after',
        state: 'due',
        channel: null,
        whenLabel: 'Wed 25 Nov, 9:00 am',
      }),
      step({
        key: 'day_9',
        ordinal: '3rd',
        offsetLabel: '9 days after',
        state: 'not_sent',
        channel: null,
        sentence: 'Dana had already had two follow-up emails that day.',
        code: 'over_daily_limit',
        whenLabel: 'Was due Mon 30 Nov, 9:00 am',
      }),
    ],
    ...over,
  };
}

function view(over: Partial<LookupFollowUpsView> = {}): LookupFollowUpsView {
  return {
    lens: 'person',
    subjectFirstName: 'Dana',
    origin: null,
    limit: null,
    truncated: { rows: null, relationships: null },
    now: [wait('a'), wait('b')],
    earlier: [],
    ...over,
  };
}

function renderSection(
  props: Partial<Parameters<typeof LookupFollowUpsSection>[0]> = {}
): ReturnType<typeof render> {
  return render(<LookupFollowUpsSection entityType="user" entityId="u1" {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LookupFollowUpsSection — states (AC7)', () => {
  it('renders a busy loading skeleton while the action is in flight', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading follow-ups…')).toBeInTheDocument();
  });

  it('asks the action for exactly this entity', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection({ entityType: 'engagement', entityId: 'e9' });
    await waitFor(() => expect(mockAction).toHaveBeenCalledWith({ type: 'engagement', id: 'e9' }));
  });

  it('shows the error title, body and a Retry that refetches', async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    mockAction.mockResolvedValueOnce({ ok: true, view: view() });
    renderSection();

    expect(await screen.findByText('Follow-ups could not be loaded')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Something went wrong on our side. Nothing was changed, and nothing was sent by opening this tab.'
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Waiting now · 2')).toBeInTheDocument();
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('moves focus off the vanished Retry button onto the panel, and keeps it there once loaded', async () => {
    const user = userEvent.setup();
    let resolveRetry: (value: unknown) => void = () => {};
    mockAction.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    mockAction.mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve)));
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    const region = screen.getByRole('status').parentElement;
    expect(region).toHaveFocus();
    expect(document.body).not.toHaveFocus();

    resolveRetry({ ok: true, view: view() });
    expect(await screen.findByText('Waiting now · 2')).toBeInTheDocument();
    expect(region).toHaveFocus();
  });

  it('does not steal focus on the first load', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    await screen.findByText('Waiting now · 2');
    expect(document.body).toHaveFocus();
  });

  it('fades the loaded content in only for users who allow motion, and stills the skeleton pulse', async () => {
    mockAction.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = renderSection();
    const pulse = screen.getByRole('status').querySelector('.animate-pulse');
    expect(pulse).toHaveClass('motion-reduce:animate-none');
    unmount();

    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    const loaded = (await screen.findByText('Waiting now · 2')).closest('.animate-in');
    expect(loaded).toHaveClass('fade-in', 'motion-reduce:animate-none');
  });

  it('treats a rejected action as unavailable', async () => {
    mockAction.mockRejectedValue(new Error('network'));
    renderSection();
    expect(await screen.findByText('Follow-ups could not be loaded')).toBeInTheDocument();
  });

  it.each([
    ['forbidden', /need platform-admin access/i],
    ['not_found', /aren't available/i],
  ] as const)('%s reads as plain copy with no Retry', async (reason, copy) => {
    mockAction.mockResolvedValue({ ok: false, reason });
    renderSection();
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText('Follow-ups could not be loaded')).not.toBeInTheDocument();
  });

  it('person-lens empty: names the person and gives the reference body', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view({ now: [], earlier: [] }) });
    renderSection();
    expect(await screen.findByText('Nothing is waiting on Dana')).toBeInTheDocument();
    expect(
      screen.getByText(/no follow-ups were sent or skipped in the last 90 days/i)
    ).toBeInTheDocument();
  });

  it('person-lens empty falls back to "this person" when the name is unknown', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ now: [], earlier: [], subjectFirstName: null }),
    });
    renderSection();
    expect(await screen.findByText('Nothing is waiting on this person')).toBeInTheDocument();
  });

  it('entity-lens empty: "Nothing here is waiting on anyone"', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ lens: 'entity', subjectFirstName: null, now: [], earlier: [] }),
    });
    renderSection({ entityType: 'project_request' });
    expect(await screen.findByText('Nothing here is waiting on anyone')).toBeInTheDocument();
  });

  it('loaded: sections, footnote, and no write-shaped control', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ earlier: [wait('old', { state: 'stopped' })] }),
    });
    renderSection();
    expect(await screen.findByText('Waiting now · 2')).toBeInTheDocument();
    expect(screen.getByText('Earlier · last 90 days')).toBeInTheDocument();
    expect(screen.getByText(/opening this tab writes nothing/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resend|pause|mute/i })).not.toBeInTheDocument();
  });

  it('a late response from a stale fetch never clobbers a newer one', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockAction.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
    mockAction.mockResolvedValueOnce({ ok: true, view: view({ now: [wait('fresh')] }) });
    const { rerender } = renderSection({ entityId: 'u1' });
    rerender(<LookupFollowUpsSection entityType="user" entityId="u2" />);
    expect(await screen.findByText('Request fresh')).toBeInTheDocument();
    resolveFirst({ ok: true, view: view({ now: [wait('stale')] }) });
    await Promise.resolve();
    expect(screen.queryByText('Request stale')).not.toBeInTheDocument();
  });
});

describe('LookupFollowUpsSection — blocks (AC6)', () => {
  it('starts every block closed when there is more than one wait', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    const headers = await screen.findAllByRole('button', { name: /Request/ });
    expect(headers).toHaveLength(2);
    for (const header of headers) expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('1st follow-up')).not.toBeInTheDocument();
  });

  it('each block header toggles aria-expanded and its step rows', async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    const [header] = await screen.findAllByRole('button', { name: /Request a/ });
    expect(header).toBeDefined();
    if (header === undefined) return;

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(header.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText('1st follow-up')).toBeInTheDocument();
    expect(
      screen.getByText('Dana had already had two follow-up emails that day.')
    ).toBeInTheDocument();
    expect(screen.getByText('over_daily_limit')).toBeInTheDocument();

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('1st follow-up')).not.toBeInTheDocument();
  });

  it('a lone wait opens itself', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view({ now: [wait('only')] }) });
    renderSection();
    const header = await screen.findByRole('button', { name: /Request only/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('1st follow-up')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /expand all|collapse all/i })
    ).not.toBeInTheDocument();
  });

  it('a lone wait among Earlier only also opens itself', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ now: [], earlier: [wait('past', { state: 'stopped' })] }),
    });
    renderSection();
    const header = await screen.findByRole('button', { name: /Request past/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not open a block by itself when Waiting now has one and Earlier has more', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ now: [wait('only')], earlier: [wait('past', { state: 'stopped' })] }),
    });
    renderSection();
    expect(await screen.findByRole('button', { name: /Request only/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /Request past/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('Expand all opens every block and becomes Collapse all', async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Expand all' }));
    for (const header of screen.getAllByRole('button', { name: /Request/ })) {
      expect(header).toHaveAttribute('aria-expanded', 'true');
    }
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    for (const header of screen.getAllByRole('button', { name: /Request/ })) {
      expect(header).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('draws one aria-hidden mark per step, with a distinct shape per state and the words beside it', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [
          wait('a', {
            steps: [
              step({ key: 'day_2', state: 'sent' }),
              step({ key: 'day_5', state: 'due', channel: null }),
              step({ key: 'day_9', state: 'not_sent', channel: null }),
            ],
          }),
          wait('b', { hasFailed: true, steps: [step({ state: 'failed', channel: null })] }),
        ],
      }),
    });
    const { container } = renderSection();
    await screen.findByText('Waiting now · 2');
    const marks = [...container.querySelectorAll('svg[data-mark]')];
    expect(marks.map((m) => m.getAttribute('data-mark'))).toEqual([
      'filled-circle',
      'ring',
      'ring-dash',
      'triangle',
    ]);
    for (const mark of marks) expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByText('1 of 3 sent · next Wed 25 Nov, 9:00 am')).toHaveLength(2);
  });

  it('colours the summary red only for a wait with a failed step', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [wait('ok'), wait('bad', { hasFailed: true, summary: '0 of 3 sent · 1 failed' })],
      }),
    });
    renderSection();
    expect(await screen.findByText('0 of 3 sent · 1 failed')).toHaveClass('text-destructive');
    expect(screen.getAllByText('1 of 3 sent · next Wed 25 Nov, 9:00 am')[0]).not.toHaveClass(
      'text-destructive'
    );
  });

  it('shows the wait state label on each block', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [wait('a'), wait('b', { state: 'finished' })],
        earlier: [wait('c', { state: 'stopped' })],
      }),
    });
    renderSection();
    expect(await screen.findByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Still waiting · follow-ups finished')).toBeInTheDocument();
    expect(screen.getByText('No longer waiting')).toBeInTheDocument();
  });

  it('a finished wait ends with the hand-off note when opened', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ now: [wait('done', { state: 'finished' })] }),
    });
    renderSection();
    expect(
      await screen.findByText(
        'Nothing more will be sent. If this still matters, a person needs to step in.'
      )
    ).toBeInTheDocument();
  });

  it('renders a failed step’s detail, a held note and the channel', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [
          wait('only', {
            steps: [
              step({
                state: 'failed',
                channel: null,
                sentence: 'It could not be sent after 3 attempts.',
                code: 'status = failed',
                detail: 'Rejected. Also on admin Home.',
                held: 'Fell due on Saturday. Held to Monday morning.',
              }),
              step({ key: 'day_5' }),
            ],
          }),
        ],
      }),
    });
    renderSection();
    expect(await screen.findByText('Failed')).toHaveClass('text-destructive');
    expect(screen.getByText('Rejected. Also on admin Home.')).toBeInTheDocument();
    expect(screen.getByText('Fell due on Saturday. Held to Monday morning.')).toBeInTheDocument();
    expect(screen.getByText('status = failed')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('names the waiting-on person on an entity lens', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ lens: 'entity', now: [wait('x', { headline: 'Dana Whitfield @ Northwind' })] }),
    });
    renderSection({ entityType: 'project_request' });
    expect(await screen.findByText(/Proposals to review · waiting on/)).toBeInTheDocument();
  });
});

describe('LookupFollowUpsSection — exempt sequences', () => {
  it('shows a wait’s note first in its open panel, and nothing when it has none', async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [
          wait('a', {
            title: 'Work to review',
            note: 'A deadline warning. Sent at its exact time.',
          }),
          wait('b'),
        ],
      }),
    });
    renderSection();
    const [first, second] = await screen.findAllByRole('button', { expanded: false });
    expect(screen.queryByText(/A deadline warning/)).not.toBeInTheDocument();
    if (first === undefined || second === undefined) throw new Error('expected two wait blocks');

    await user.click(second);
    expect(screen.queryByText(/A deadline warning/)).not.toBeInTheDocument();

    await user.click(first);
    const note = screen.getByText('A deadline warning. Sent at its exact time.');
    const panel = note.closest('div');
    expect(panel?.firstElementChild).toBe(note);
  });
});

describe('LookupFollowUpsSection — origin note and daily limit', () => {
  it('shows the engagement origin note', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ lens: 'entity', origin: { requestTitle: 'Salesforce CPQ rollout' } }),
    });
    renderSection({ entityType: 'engagement' });
    expect(
      await screen.findByText(
        'Proposal follow-ups here are from Salesforce CPQ rollout, the request this engagement came from.'
      )
    ).toBeInTheDocument();
  });

  it('leaves the origin note off the empty state of an engagement', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        lens: 'entity',
        now: [],
        earlier: [],
        origin: { requestTitle: 'Salesforce CPQ rollout' },
      }),
    });
    renderSection({ entityType: 'engagement' });
    expect(await screen.findByText('Nothing here is waiting on anyone')).toBeInTheDocument();
    expect(screen.queryByText(/the request this engagement came from/)).not.toBeInTheDocument();
  });

  it('leaves the origin note off when an engagement only has its own delivery waits', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        lens: 'entity',
        now: [wait('delivery', { title: 'Work to review' })],
        origin: { requestTitle: 'Salesforce CPQ rollout' },
      }),
    });
    renderSection({ entityType: 'engagement' });
    expect(await screen.findByText('Request delivery')).toBeInTheDocument();
    expect(screen.queryByText(/the request this engagement came from/)).not.toBeInTheDocument();
  });

  it('shows the origin note when only an earlier wait is a proposal wait', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        lens: 'entity',
        now: [wait('delivery', { title: 'Work to review' })],
        earlier: [wait('proposal', { state: 'stopped' })],
        origin: { requestTitle: 'Salesforce CPQ rollout' },
      }),
    });
    renderSection({ entityType: 'engagement' });
    expect(
      await screen.findByText(
        'Proposal follow-ups here are from Salesforce CPQ rollout, the request this engagement came from.'
      )
    ).toBeInTheDocument();
  });

  it('shows neither origin line on an empty state that has no engagement context', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view({ now: [], earlier: [] }) });
    renderSection();
    await screen.findByText(/Nothing is waiting on Dana/);
    expect(screen.queryByText(/the request this engagement came from/)).not.toBeInTheDocument();
  });

  it('shows the limit strip with the used count, and no skip sentence below the limit', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ limit: { used: 1, of: 2, full: false } }),
    });
    renderSection();
    expect(await screen.findByText('1 of 2 follow-up emails today')).toBeInTheDocument();
    expect(screen.queryByText(/is skipped/)).not.toBeInTheDocument();
    expect(screen.getByText('Deadline warnings do not count.')).toBeInTheDocument();
  });

  it('a full limit says the next one due for the person is skipped', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ limit: { used: 2, of: 2, full: true } }),
    });
    renderSection();
    expect(await screen.findByText('2 of 2 follow-up emails today')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The next one due for Dana today is skipped. Deadline warnings do not count.'
      )
    ).toBeInTheDocument();
  });

  it('a full limit for an unnamed person says "this person"', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ subjectFirstName: null, limit: { used: 2, of: 2, full: true } }),
    });
    renderSection();
    expect(
      await screen.findByText(
        'The next one due for this person today is skipped. Deadline warnings do not count.'
      )
    ).toBeInTheDocument();
  });

  it('shows no limit strip on an entity lens', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view({ lens: 'entity', limit: null }) });
    renderSection({ entityType: 'project_request' });
    await screen.findByText('Waiting now · 2');
    expect(screen.queryByText(/follow-up emails today/)).not.toBeInTheDocument();
  });
});

describe('LookupFollowUpsSection — delivery and truncation (BAL-666)', () => {
  it('shows the delivery lines and the Not delivered word on an opened wait', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({
        now: [
          wait('a', {
            hasFailed: true,
            steps: [
              step({
                state: 'sent',
                delivery: [
                  { key: 'email-0', text: 'Email sent' },
                  { key: 'in_app-1', text: 'In-app failed: Muted' },
                ],
              }),
              step({
                key: 'day_5',
                state: 'failed',
                label: 'Not delivered',
                channel: null,
                delivery: [{ key: 'email-0', text: 'Email failed: Bounced' }],
              }),
              step({
                key: 'day_9',
                state: 'sent',
                delivery: [{ key: 'not-recorded', text: 'Delivery not recorded yet' }],
              }),
            ],
          }),
        ],
      }),
    });
    renderSection();

    expect(await screen.findByText('Email sent')).toBeInTheDocument();
    expect(screen.getByText('In-app failed: Muted')).toBeInTheDocument();
    expect(screen.getByText('Not delivered')).toBeInTheDocument();
    expect(screen.getByText('Email failed: Bounced')).toBeInTheDocument();
    expect(screen.getByText('Delivery not recorded yet')).toBeInTheDocument();
  });

  it('shows the row-limit notice as text when the row cap was hit', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ truncated: { rows: 500, relationships: null } }),
    });
    renderSection();
    expect(
      await screen.findByText(
        'Showing the most recent 500 follow-up emails. Older ones are not listed.'
      )
    ).toBeInTheDocument();
  });

  it('shows the relationship-limit notice when that cap was hit', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      view: view({ lens: 'entity', truncated: { rows: null, relationships: 200 } }),
    });
    renderSection({ entityType: 'project_request' });
    expect(
      await screen.findByText(
        'Showing follow-ups for the first 200 invitations on this request. Later invitations are not listed.'
      )
    ).toBeInTheDocument();
  });

  it('shows no notice when nothing was cut short', async () => {
    mockAction.mockResolvedValue({ ok: true, view: view() });
    renderSection();
    await screen.findByText('Waiting now · 2');
    expect(screen.queryByText(/Older ones are not listed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Later invitations are not listed/)).not.toBeInTheDocument();
  });
});
