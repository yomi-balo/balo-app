import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '@/test/utils';
import { axe } from '@/test/axe';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock('@/app/(dashboard)/engagements/[id]/_actions/save-change-order', () => ({
  saveChangeOrderAction: vi.fn(),
}));

import { toast } from 'sonner';
import { saveChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/save-change-order';
import { ChangeOrderComposer, type ChangeOrderComposerOrder } from './change-order-composer';
import type { ComposerMilestone } from './change-order-composer-state';

const saveMock = vi.mocked(saveChangeOrderAction);

const MILESTONES: ComposerMilestone[] = [
  {
    id: 'm1',
    title: 'Discovery',
    descriptionText: 'Workshops.',
    status: 'completed',
    estimatedMinutes: 600,
  },
  {
    id: 'm2',
    title: 'Build',
    descriptionText: null,
    status: 'in_progress',
    estimatedMinutes: 1200,
  },
];

interface Overrides {
  pricingMethod?: 'fixed' | 'tm';
  milestones?: ComposerMilestone[];
  order?: ChangeOrderComposerOrder | null;
  hourlyRateCents?: number | null;
  loggedValueCents?: number | null;
}

function renderComposer(overrides: Overrides = {}): ReturnType<typeof render> {
  return render(
    <ChangeOrderComposer
      engagementId="eng-1"
      pricingMethod={overrides.pricingMethod ?? 'fixed'}
      clientCompanyName="Northwind"
      projectTitle="CRM rollout"
      currency="aud"
      currentPriceCents={1250000}
      hourlyRateCents={overrides.hourlyRateCents ?? null}
      loggedValueCents={overrides.loggedValueCents ?? null}
      milestones={overrides.milestones ?? MILESTONES}
      order={overrides.order ?? null}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ success: true });
});

describe('ChangeOrderComposer', () => {
  it('pre-fills every live milestone and the current price', () => {
    renderComposer();
    expect(screen.getByRole('heading', { name: 'Propose a change' })).toBeInTheDocument();
    expect(screen.getByText('CRM rollout')).toBeInTheDocument();
    expect(
      screen.getAllByLabelText('Milestone name').map((el) => (el as HTMLInputElement).value)
    ).toEqual(['Discovery', 'Build']);
    expect(screen.getByLabelText('Project price')).toHaveValue(12500);
    expect(
      screen.getByText(/Currently A\$12,500\. Leave it to keep the price\./)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to project/ })).toHaveAttribute(
      'href',
      '/engagements/eng-1'
    );
  });

  it('shows the client request banner when the order came from a request', () => {
    renderComposer({
      order: {
        id: 'o1',
        status: 'requested',
        requestNote: 'Please add a dashboard.',
        requestedHeading: 'Dana @ Northwind asked for a change on 15 Oct',
        note: null,
        priceDeltaCents: null,
        lines: [],
      },
    });
    expect(screen.getByText(/Dana @ Northwind asked for a change on 15 Oct/)).toBeInTheDocument();
    expect(screen.getByText(/Please add a dashboard\./)).toBeInTheDocument();
  });

  it('removes and restores a milestone, with a note for completed work', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getAllByRole('button', { name: /Remove/ })[0]!);
    expect(screen.getByText('This milestone is already completed.')).toBeInTheDocument();
    expect(screen.getByText('1 removed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Keep it/ }));
    expect(screen.getByText('0 removed')).toBeInTheDocument();
  });

  it('adds and discards a new milestone row', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: /Add a milestone/ }));
    expect(screen.getAllByLabelText('Milestone name')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /Discard/ }));
    expect(screen.getAllByLabelText('Milestone name')).toHaveLength(2);
  });

  it('invites the first milestone when the plan has none', () => {
    renderComposer({ milestones: [] });
    expect(screen.getByText('Add the first milestone this change brings in.')).toBeInTheDocument();
  });

  it('blocks send and lists what is missing', async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.queryByLabelText('Fix before sending')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));
    const issues = screen.getByLabelText('Fix before sending');
    expect(issues).toHaveTextContent("Add a short summary of what's changing and why.");
    expect(issues).toHaveTextContent('Change at least one milestone or the price.');
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('sends a fixed-price change with cents and lines, then returns to the workspace', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByLabelText(/What's changing and why/), 'Reprice the build');
    const price = screen.getByLabelText('Project price');
    await user.clear(price);
    await user.type(price, '13000');
    expect(screen.getByText(/That's \+A\$500\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      note: 'Reprice the build',
      newTotalCents: 1300000,
      lines: [],
      send: true,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/engagements/eng-1'));
    expect(toast.success).toHaveBeenCalledWith(
      'Sent to Northwind. Nothing changes until they approve.'
    );
  });

  it('sends T&M estimates as whole minutes', async () => {
    const user = userEvent.setup();
    renderComposer({ pricingMethod: 'tm' });
    expect(screen.getByText(/30 hrs → 30 hrs/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/What's changing and why/), 'More build time');
    const hours = screen.getAllByLabelText('Estimate in hours')[1]!;
    await user.clear(hours);
    await user.type(hours, '25.5');
    expect(screen.getByText('was 20 hrs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      note: 'More build time',
      newTotalCents: 1250000,
      lines: [
        {
          op: 'edit',
          milestoneId: 'm2',
          title: 'Build',
          descriptionText: null,
          estimatedMinutes: 1530,
        },
      ],
      send: true,
    });
  });

  it('T&M: pre-fills the current cap and sends a raised cap', async () => {
    const user = userEvent.setup();
    renderComposer({ pricingMethod: 'tm' });
    const cap = screen.getByLabelText('Cap');
    expect(cap).toHaveValue(12500);
    expect(
      screen.getByText(/Currently A\$12,500\. Leave it to keep the cap\./)
    ).toBeInTheDocument();
    await user.clear(cap);
    await user.type(cap, '14000');
    expect(screen.getByText(/That's \+A\$1,500\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[0]).toMatchObject({ newTotalCents: 1400000, send: false });
  });

  it('T&M: warns when the estimate at the rate passes the cap, and raises it in one click', async () => {
    const user = userEvent.setup();
    renderComposer({ pricingMethod: 'tm', hourlyRateCents: 50000 });
    expect(
      screen.getByText(
        /At A\$500\/hr the new estimate comes to A\$15,000, above the A\$12,500 cap\./
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raise cap to A$15,000' }));
    expect(screen.getByLabelText('Cap')).toHaveValue(15000);
    expect(screen.queryByRole('button', { name: /Raise cap to/ })).not.toBeInTheDocument();
  });

  it('T&M: refuses a cap lowered below the value of the time already logged', async () => {
    const user = userEvent.setup();
    renderComposer({ pricingMethod: 'tm', loggedValueCents: 1200000 });
    await user.clear(screen.getByLabelText('Cap'));
    await user.type(screen.getByLabelText('Cap'), '11000');
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));
    expect(
      screen.getByText("The cap can't go below A$12,000 — the value of the time already logged.")
    ).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('T&M: accepts a lowered cap that stays at or above the logged value', async () => {
    const user = userEvent.setup();
    renderComposer({ pricingMethod: 'tm', loggedValueCents: 1200000 });
    await user.clear(screen.getByLabelText('Cap'));
    await user.type(screen.getByLabelText('Cap'), '12000');
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));
    expect(screen.queryByText(/The cap can't go below/)).not.toBeInTheDocument();
  });

  it('T&M: shows a rate that is not a whole amount with cents', () => {
    renderComposer({ pricingMethod: 'tm', hourlyRateCents: 50050 });
    expect(screen.getByText(/At A\$500\.50\/hr/)).toBeInTheDocument();
  });

  it('T&M: no cap warning while the estimate fits under the cap', () => {
    renderComposer({ pricingMethod: 'tm', hourlyRateCents: 12000 });
    expect(screen.queryByText(/above the/)).not.toBeInTheDocument();
  });

  it('tells the client reads the note word for word and to leave amounts to the price box', () => {
    renderComposer();
    expect(
      screen.getByText(
        /Northwind reads this word for word\. Describe the change, and leave amounts/
      )
    ).toBeInTheDocument();
  });

  it('a send that fails after the save keeps the saved order, so a retry sends it instead of opening another', async () => {
    const user = userEvent.setup();
    saveMock.mockResolvedValueOnce({
      success: false,
      error: "Add a short summary of what's changing and why.",
      changeOrderId: 'saved-1',
    });
    renderComposer();
    await user.type(screen.getByLabelText(/What's changing and why/), 'Needs a dashboard');
    await user.click(screen.getByRole('button', { name: 'Add a milestone' }));
    await user.type(screen.getAllByLabelText('Milestone name')[2]!, 'Dashboard');
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty('orderId');

    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(saveMock.mock.calls[1]?.[0]).toMatchObject({ orderId: 'saved-1', send: true });
  });

  it('saves a draft without running the send checks, carrying the order id', async () => {
    const user = userEvent.setup();
    renderComposer({
      order: {
        id: 'o1',
        status: 'draft',
        requestNote: null,
        requestedHeading: null,
        note: 'Draft note',
        priceDeltaCents: 50000,
        lines: [],
      },
    });
    expect(screen.getByLabelText('Project price')).toHaveValue(13000);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      orderId: 'o1',
      note: 'Draft note',
      newTotalCents: 1300000,
      lines: [],
      send: false,
    });
    expect(toast.success).toHaveBeenCalledWith('Draft saved.');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/engagements/eng-1'));
  });

  it('refuses to save a draft with an unnamed new milestone', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: /Add a milestone/ }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(toast.error).toHaveBeenCalledWith('Give each milestone a name before saving.');
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('toasts the returned copy and stays put when the save fails', async () => {
    const user = userEvent.setup();
    saveMock.mockResolvedValue({
      success: false,
      error: 'This project changed. Refresh and try again.',
    });
    renderComposer();
    await user.type(screen.getByLabelText(/What's changing and why/), 'Reprice');
    const price = screen.getByLabelText('Project price');
    await user.clear(price);
    await user.type(price, '9000');
    await user.click(screen.getByRole('button', { name: /Send to Northwind/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This project changed. Refresh and try again.')
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderComposer();
    expect(await axe(container)).toHaveNoViolations();
  });
});
