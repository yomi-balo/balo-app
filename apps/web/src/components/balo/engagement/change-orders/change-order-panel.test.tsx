import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '@/test/utils';
import type {
  ChangeOrderAffordances,
  ChangeOrderItemView,
  ChangeOrderPanelView,
} from '@/lib/engagement/change-order-view';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

vi.mock('@/app/(dashboard)/engagements/[id]/_actions/answer-change-request', () => ({
  answerChangeRequestAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/discard-change-order-draft', () => ({
  discardChangeOrderDraftAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/withdraw-change-order', () => ({
  withdrawChangeOrderAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/approve-change-order', () => ({
  approveChangeOrderAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/decline-change-order', () => ({
  declineChangeOrderAction: vi.fn(),
}));

import { toast } from 'sonner';
import { answerChangeRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/answer-change-request';
import { discardChangeOrderDraftAction } from '@/app/(dashboard)/engagements/[id]/_actions/discard-change-order-draft';
import { withdrawChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-change-order';
import { approveChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/approve-change-order';
import { declineChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/decline-change-order';
import { ChangeOrderPanel } from './change-order-panel';

const answerMock = vi.mocked(answerChangeRequestAction);
const discardMock = vi.mocked(discardChangeOrderDraftAction);
const withdrawMock = vi.mocked(withdrawChangeOrderAction);
const approveMock = vi.mocked(approveChangeOrderAction);
const declineMock = vi.mocked(declineChangeOrderAction);

const NO_AFFORDANCES: ChangeOrderAffordances = {
  requestChange: false,
  propose: false,
  answer: false,
  continueDraft: false,
  discardDraft: false,
  withdraw: false,
  decide: false,
  decideNotice: null,
  proposeDisabledReason: null,
};

function item(overrides: Partial<ChangeOrderItemView> = {}): ChangeOrderItemView {
  return {
    id: 'o1',
    pricingMethod: 'fixed',
    sentOnLabel: '18 Oct',
    sentByLabel: 'Charles @ CloudPeak',
    status: 'sent',
    pill: { label: 'Waiting', tone: 'violet' },
    summary: 'Adds a marketing dashboard.',
    requestNote: null,
    requestedHeading: null,
    datesLabel: 'Sent 18 Oct',
    lines: [
      {
        op: 'add',
        title: 'Marketing dashboard',
        descriptionText: 'KPI board.',
        estimateLabel: null,
        before: null,
      },
    ],
    priceEffect: {
      text: 'Project price A$15,625 → A$17,500 (+A$1,875)',
      hint: 'If you approve, A$1,875 is added to your final invoice.',
    },
    deltaChip: '+A$1,875',
    answerText: null,
    declineText: null,
    ...overrides,
  };
}

function view(overrides: Partial<ChangeOrderPanelView> = {}): ChangeOrderPanelView {
  return {
    open: null,
    affordances: NO_AFFORDANCES,
    outcome: null,
    history: [],
    composerHref: '/engagements/eng-1/change-order',
    footnote: 'Footnote.',
    adminStateLine: null,
    ...overrides,
  };
}

function renderPanel(
  lens: 'client' | 'expert' | 'admin',
  panelView: ChangeOrderPanelView
): ReturnType<typeof render> {
  return render(
    <ChangeOrderPanel
      engagementId="eng-1"
      lens={lens}
      view={panelView}
      clientParty="Northwind"
      expertParty="CloudPeak"
      expertActor="Charles @ CloudPeak"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [answerMock, discardMock, withdrawMock, approveMock, declineMock]) {
    mock.mockResolvedValue({ success: true });
  }
});

describe('ChangeOrderPanel · expert', () => {
  const request = item({
    status: 'requested',
    requestNote: 'Please add a dashboard.',
    requestedHeading: 'Dana @ Northwind asked for a change on 15 Oct',
    summary: null,
    lines: [],
    priceEffect: null,
  });

  it('shows the request with both ways to reply', () => {
    renderPanel(
      'expert',
      view({ open: request, affordances: { ...NO_AFFORDANCES, propose: true, answer: true } })
    );
    expect(
      screen.getByRole('heading', { name: 'Dana @ Northwind asked for a change on 15 Oct' })
    ).toBeInTheDocument();
    expect(screen.getByText('“Please add a dashboard.”')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Propose a change/ })).toHaveAttribute(
      'href',
      '/engagements/eng-1/change-order'
    );
    expect(screen.getByRole('button', { name: 'Answer without a change order' })).toBeEnabled();
  });

  it('requires text to send an answer, then sends it and toasts', async () => {
    const user = userEvent.setup();
    renderPanel(
      'expert',
      view({ open: request, affordances: { ...NO_AFFORDANCES, propose: true, answer: true } })
    );
    await user.click(screen.getByRole('button', { name: 'Answer without a change order' }));
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Your answer'), '  Already covered.  ');
    await user.click(send);

    await waitFor(() =>
      expect(answerMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        orderId: 'o1',
        answer: 'Already covered.',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Answer sent.');
    expect(refresh).toHaveBeenCalled();
  });

  it('cancels the answer box', async () => {
    const user = userEvent.setup();
    renderPanel(
      'expert',
      view({ open: request, affordances: { ...NO_AFFORDANCES, answer: true } })
    );
    await user.click(screen.getByRole('button', { name: 'Answer without a change order' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('button', { name: 'Answer without a change order' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
  });

  it('toasts the returned error and does not close the answer box', async () => {
    const user = userEvent.setup();
    answerMock.mockResolvedValue({ success: false, error: 'That change was already decided.' });
    renderPanel(
      'expert',
      view({ open: request, affordances: { ...NO_AFFORDANCES, answer: true } })
    );
    await user.click(screen.getByRole('button', { name: 'Answer without a change order' }));
    await user.type(screen.getByLabelText('Your answer'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That change was already decided.')
    );
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
  });

  it('shows the unsent draft banner with continue and discard', async () => {
    const user = userEvent.setup();
    const draft = item({ status: 'draft', summary: 'Wip', lines: [], priceEffect: null });
    renderPanel(
      'expert',
      view({
        open: draft,
        affordances: { ...NO_AFFORDANCES, continueDraft: true, discardDraft: true },
      })
    );
    expect(screen.getByText("You have a draft change that hasn't been sent.")).toBeInTheDocument();
    expect(screen.queryByText(/still waiting for your answer/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue editing' })).toHaveAttribute(
      'href',
      '/engagements/eng-1/change-order'
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.getByText('Your draft is discarded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() =>
      expect(discardMock).toHaveBeenCalledWith({ engagementId: 'eng-1', orderId: 'o1' })
    );
    expect(toast.success).toHaveBeenCalledWith('Draft discarded.');
  });

  it('says the client is still waiting when the draft came from a request', () => {
    const draft = item({ status: 'draft', requestNote: 'Please.', lines: [], priceEffect: null });
    renderPanel(
      'expert',
      view({ open: draft, affordances: { ...NO_AFFORDANCES, continueDraft: true } })
    );
    expect(screen.getByText(/Northwind is still waiting for your answer\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });

  it('withdraws a sent change only after confirming', async () => {
    const user = userEvent.setup();
    renderPanel(
      'expert',
      view({ open: item(), affordances: { ...NO_AFFORDANCES, withdraw: true } })
    );
    expect(screen.getByText('Change sent to Northwind.')).toBeInTheDocument();
    expect(
      screen.getByText(/The milestones it touches are locked until then\./)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(withdrawMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep it sent' }));
    expect(withdrawMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await user.click(screen.getByRole('button', { name: 'Withdraw change' }));
    await waitFor(() =>
      expect(withdrawMock).toHaveBeenCalledWith({ engagementId: 'eng-1', orderId: 'o1' })
    );
    expect(toast.success).toHaveBeenCalledWith('Change withdrawn.');
  });

  it('offers no withdraw when the view does not allow it', () => {
    renderPanel('expert', view({ open: item() }));
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('shows the outcome of the last decided change when nothing is open', () => {
    renderPanel(
      'expert',
      view({ outcome: { tone: 'emerald', text: 'Northwind approved the change on 20 Oct.' } })
    );
    expect(screen.getByText('Northwind approved the change on 20 Oct.')).toBeInTheDocument();
  });
});

describe('ChangeOrderPanel · client', () => {
  it('shows the proposed change with its difference, price effect and both controls', () => {
    renderPanel('client', view({ open: item(), affordances: { ...NO_AFFORDANCES, decide: true } }));
    expect(
      screen.getByRole('heading', { name: 'Charles @ CloudPeak proposed a change' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Sent 18 Oct\. Nothing changes unless you approve it\./)
    ).toBeInTheDocument();
    expect(screen.getByText('Adds a marketing dashboard.')).toBeInTheDocument();
    expect(screen.getByText('Marketing dashboard')).toBeInTheDocument();
    expect(screen.getByText('Project price A$15,625 → A$17,500 (+A$1,875)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve change' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it('names the approving party and hides the buttons for a participant who cannot decide', () => {
    const notice =
      'Northwind approves changes — anyone who can approve proposals for Northwind can approve or decline this.';
    renderPanel(
      'client',
      view({ open: item(), affordances: { ...NO_AFFORDANCES, decideNotice: notice } })
    );
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(screen.getByText(/Nothing changes unless Northwind approves it\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
  });

  it('quotes the original request when there was one', () => {
    renderPanel(
      'client',
      view({
        open: item({ requestNote: 'Please add a dashboard.' }),
        affordances: { ...NO_AFFORDANCES, decide: true },
      })
    );
    expect(screen.getByText(/You asked: “Please add a dashboard\.”/)).toBeInTheDocument();
  });

  it('approves and toasts the fixed-price copy', async () => {
    const user = userEvent.setup();
    renderPanel('client', view({ open: item(), affordances: { ...NO_AFFORDANCES, decide: true } }));
    await user.click(screen.getByRole('button', { name: 'Approve change' }));
    await waitFor(() =>
      expect(approveMock).toHaveBeenCalledWith({ engagementId: 'eng-1', orderId: 'o1' })
    );
    expect(toast.success).toHaveBeenCalledWith('Change approved — the plan and price are updated.');
  });

  it('toasts the estimate copy for a time-and-materials change', async () => {
    const user = userEvent.setup();
    const tm = item({
      pricingMethod: 'tm',
      priceEffect: { text: 'Estimate 56 hrs → 66 hrs (+10 hrs)', hint: null },
    });
    renderPanel('client', view({ open: tm, affordances: { ...NO_AFFORDANCES, decide: true } }));
    await user.click(screen.getByRole('button', { name: 'Approve change' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Change approved — the plan and estimates are updated.'
      )
    );
  });

  it('toasts the cap copy when a time-and-materials change moves the cap', async () => {
    const user = userEvent.setup();
    const tm = item({
      pricingMethod: 'tm',
      priceEffect: {
        text: 'Estimate 56 hrs → 66 hrs (+10 hrs)',
        capText: 'Cap A$12,500 → A$13,750 (+A$1,250)',
        hint: null,
      },
    });
    renderPanel('client', view({ open: tm, affordances: { ...NO_AFFORDANCES, decide: true } }));
    expect(screen.getByText('Cap A$12,500 → A$13,750 (+A$1,250)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve change' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Change approved — the plan, estimates and cap are updated.'
      )
    );
  });

  it('requires a reason to decline, then declines with the trimmed reason', async () => {
    const user = userEvent.setup();
    renderPanel('client', view({ open: item(), affordances: { ...NO_AFFORDANCES, decide: true } }));
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByText('Why are you declining?')).toBeInTheDocument();
    const decline = screen.getByRole('button', { name: 'Decline change' });
    expect(decline).toBeDisabled();
    await user.type(screen.getByLabelText('Why are you declining?'), '   ');
    expect(decline).toBeDisabled();
    await user.type(screen.getByLabelText('Why are you declining?'), ' Too much. ');
    await user.click(decline);

    await waitFor(() =>
      expect(declineMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        orderId: 'o1',
        reason: 'Too much.',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Change declined.');
  });

  it('backs out of declining', async () => {
    const user = userEvent.setup();
    renderPanel('client', view({ open: item(), affordances: { ...NO_AFFORDANCES, decide: true } }));
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Approve change' })).toBeInTheDocument();
    expect(declineMock).not.toHaveBeenCalled();
  });

  it('hides the decision controls when the client may not decide', () => {
    renderPanel('client', view({ open: item() }));
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
  });

  it('acknowledges an open request without any controls', () => {
    const request = item({
      status: 'requested',
      requestedHeading: 'You asked for a change on 15 Oct',
      lines: [],
      priceEffect: null,
    });
    renderPanel('client', view({ open: request }));
    expect(
      screen.getByText(
        /You asked for a change on 15 Oct\. CloudPeak will reply with a proposed change or an answer\./
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the outcome banner when nothing is open', () => {
    renderPanel(
      'client',
      view({
        outcome: { tone: 'slate', text: 'Charles @ CloudPeak answered your request: “Done.”' },
      })
    );
    expect(screen.getByText(/answered your request/)).toBeInTheDocument();
  });
});

describe('ChangeOrderPanel · admin and empty', () => {
  it('shows the admin state line and no controls', () => {
    renderPanel(
      'admin',
      view({
        open: item(),
        adminStateLine: 'Waiting on Northwind since 18 Oct (3 business days).',
        affordances: { ...NO_AFFORDANCES, decide: true },
      })
    );
    expect(
      screen.getByText('Waiting on Northwind since 18 Oct (3 business days).')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing for an admin with no open order', () => {
    const { container } = renderPanel('admin', view());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is neither an open order nor an outcome', () => {
    const { container } = renderPanel('client', view());
    expect(container).toBeEmptyDOMElement();
  });
});
