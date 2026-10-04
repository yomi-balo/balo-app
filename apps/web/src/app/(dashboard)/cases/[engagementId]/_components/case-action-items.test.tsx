import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type { CaseActionItemsView } from '@/lib/cases/case-view-types';

vi.mock('../_actions/set-case-action-item-status', () => ({
  setCaseActionItemStatusAction: vi.fn(),
}));

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { setCaseActionItemStatusAction } from '../_actions/set-case-action-item-status';
import { CaseActionItems } from './case-action-items';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';

/**
 * BAL-421 — the rail's action-items card: three LENS-RELATIVE buckets, with a done toggle when
 * the viewer may change status (`canToggle`).
 *
 * ⚠⚠ THE UNASSIGNED GROUP RENDERS EVEN WHEN THE OTHER TWO ARE EMPTY, and that is the assertion
 * this file exists for. `unassigned` is where `ai_extracted` items land — a TRIAGE QUEUE — so
 * folding it into "show the groups that have items" reads the same on every fixture except the
 * one that matters: a case whose only items came out of the transcript pipeline.
 *
 * ⚠ THE EMPTY STATE IS AN INVITATION, NOT AN ABSENCE (balo-ui). "No action items yet" defines
 * the section by what it lacks; the copy here says what action items ARE and where they come
 * from, so the section reads as ready rather than broken.
 */

function item(
  over: Readonly<Partial<ActionItemNodeView>> & Readonly<{ id: string }>
): ActionItemNodeView {
  return {
    body: 'Send the sandbox credentials',
    status: 'open',
    assigneeParty: null,
    assigneeLabel: null,
    dueLabel: null,
    dueAtValue: null,
    isOverdue: false,
    ...over,
  };
}

function view(over: Readonly<Partial<CaseActionItemsView>> = {}): CaseActionItemsView {
  return {
    yours: [],
    theirs: [],
    unassigned: [],
    counterpartyLabel: 'Amara',
    totalCount: 0,
    canToggle: false,
    ...over,
  };
}

/** The heading each bucket renders. `theirs` is `${counterpartyLabel}'s`. */
const YOURS = 'Yours';
const THEIRS = "Amara's";
const UNASSIGNED = 'Unassigned';
const INVITATION =
  'Anything you agree to do on a call lands here, so nothing gets lost between consultations.';

describe('CaseActionItems — the empty card invites rather than reporting an absence', () => {
  it('renders the invitation copy and NO bucket headings when nothing exists', () => {
    render(<CaseActionItems engagementId={ENGAGEMENT_ID} actionItems={view()} />);
    expect(screen.getByText(INVITATION)).toBeInTheDocument();
    for (const heading of [YOURS, THEIRS, UNASSIGNED]) {
      expect(screen.queryByText(heading)).not.toBeInTheDocument();
    }
  });

  it('never frames the empty state as an absence — no "No action items", no "yet"', () => {
    const { container } = render(
      <CaseActionItems engagementId={ENGAGEMENT_ID} actionItems={view()} />
    );
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('no action items');
    expect(text).not.toContain('yet');
  });

  /** ⚠ 0-TOTAL EDGE: `0/0` is a progress claim about nothing. The meta is omitted entirely. */
  it('renders NO progress meta on the 0-total edge', () => {
    const { container } = render(
      <CaseActionItems engagementId={ENGAGEMENT_ID} actionItems={view()} />
    );
    expect(container.textContent ?? '').not.toContain('0/0');
    // The meta is the ONLY place a slash appears on this card, so its absence is the assertion
    // (stated without a regex — `regexp/no-super-linear-move` rejects `\d+\/\d+`).
    expect(container.textContent ?? '').not.toContain('/');
  });

  it('KEEPS the section rather than hiding it — the heading always renders', () => {
    render(<CaseActionItems engagementId={ENGAGEMENT_ID} actionItems={view()} />);
    expect(screen.getByRole('heading', { name: 'Action items' })).toBeInTheDocument();
  });
});

describe('CaseActionItems — the three buckets, each empty and non-empty', () => {
  it('renders YOURS alone when only the viewer has items', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [item({ id: 'a-1', body: 'Draft the migration plan' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(YOURS)).toBeInTheDocument();
    expect(screen.getByText(/Draft the migration plan/)).toBeInTheDocument();
    expect(screen.queryByText(THEIRS)).not.toBeInTheDocument();
    expect(screen.queryByText(UNASSIGNED)).not.toBeInTheDocument();
  });

  it("renders THEIRS under the counterparty's own label, not a generic word", () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          theirs: [item({ id: 'a-2', body: 'Share the flow export' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(THEIRS)).toBeInTheDocument();
    expect(screen.getByText(/Share the flow export/)).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
    expect(screen.queryByText(YOURS)).not.toBeInTheDocument();
  });

  it('follows the counterpartyLabel it is given — the label is not hardcoded', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          counterpartyLabel: 'Northwind Industrial',
          theirs: [item({ id: 'a-3' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText("Northwind Industrial's")).toBeInTheDocument();
    expect(screen.queryByText(THEIRS)).not.toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE TRIAGE QUEUE. `ai_extracted` items land unassigned, so this is the ONLY place the
   * transcript pipeline's output becomes visible — hiding it when the other two are empty would
   * hide it exactly when it is the whole content of the card.
   */
  it('renders UNASSIGNED even when both other buckets are empty', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          unassigned: [item({ id: 'a-4', body: 'Confirm the sandbox refresh window' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(UNASSIGNED)).toBeInTheDocument();
    expect(screen.getByText(/Confirm the sandbox refresh window/)).toBeInTheDocument();
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });

  it('renders all three buckets together, each with its own items', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [item({ id: 'y-1', body: 'Mine' })],
          theirs: [item({ id: 't-1', body: 'Theirs' })],
          unassigned: [item({ id: 'u-1', body: 'Nobodys' })],
          totalCount: 3,
        })}
      />
    );
    for (const heading of [YOURS, THEIRS, UNASSIGNED]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('CaseActionItems — the progress meta states done over total', () => {
  it('renders done/total once there is anything to count', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [item({ id: 'y-1', status: 'done' }), item({ id: 'y-2' })],
          unassigned: [item({ id: 'u-1' })],
          totalCount: 3,
        })}
      />
    );
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('renders a fully-done case as total/total, not as an empty card', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [item({ id: 'y-1', status: 'done' }), item({ id: 'y-2', status: 'done' })],
          totalCount: 2,
        })}
      />
    );
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });

  it('marks each item done or open for a screen reader, not by strike-through alone', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [
            item({ id: 'y-1', body: 'Finished thing', status: 'done' }),
            item({ id: 'y-2', body: 'Outstanding thing' }),
          ],
          totalCount: 2,
        })}
      />
    );
    expect(screen.getByText('(done)')).toBeInTheDocument();
    expect(screen.getByText('(open)')).toBeInTheDocument();
  });

  it('offers no controls when the viewer may not toggle (closed case, or no act right)', () => {
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({ yours: [item({ id: 'y-1' })], totalCount: 1 })}
      />
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('CaseActionItems — marking done and reopening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setCaseActionItemStatusAction).mockResolvedValue({
      success: true,
      actionItemId: 'y-1',
    });
  });

  it('marks an open item done through the CASE action, toasts, and refreshes', async () => {
    const user = userEvent.setup();
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          yours: [item({ id: 'y-1', body: 'Send the plan' })],
          totalCount: 1,
          canToggle: true,
        })}
      />
    );

    await user.click(screen.getByRole('checkbox', { name: 'Mark done: Send the plan' }));

    expect(setCaseActionItemStatusAction).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      actionItemId: 'y-1',
      status: 'done',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marked done'));
    expect(refreshMock).toHaveBeenCalled();
  });

  it('reopens a done item', async () => {
    const user = userEvent.setup();
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({
          unassigned: [item({ id: 'y-1', body: 'Send the plan', status: 'done' })],
          totalCount: 1,
          canToggle: true,
        })}
      />
    );

    await user.click(screen.getByRole('checkbox', { name: 'Reopen action item: Send the plan' }));

    expect(setCaseActionItemStatusAction).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      actionItemId: 'y-1',
      status: 'open',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reopened'));
  });

  it('toasts the returned error verbatim and still refreshes to server truth', async () => {
    vi.mocked(setCaseActionItemStatusAction).mockResolvedValue({
      success: false,
      error: 'This case is closed, so its action items can no longer change.',
    });
    const user = userEvent.setup();
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({ yours: [item({ id: 'y-1' })], totalCount: 1, canToggle: true })}
      />
    );

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This case is closed, so its action items can no longer change.'
      )
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it('moves the done/total meta optimistically while the write is in flight', async () => {
    let resolve: ((value: { success: true; actionItemId: string }) => void) | undefined;
    vi.mocked(setCaseActionItemStatusAction).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const user = userEvent.setup();
    render(
      <CaseActionItems
        engagementId={ENGAGEMENT_ID}
        actionItems={view({ yours: [item({ id: 'y-1' })], totalCount: 1, canToggle: true })}
      />
    );
    expect(screen.getByText('0/1')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox'));

    expect(await screen.findByText('1/1')).toBeInTheDocument();
    resolve?.({ success: true, actionItemId: 'y-1' });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
