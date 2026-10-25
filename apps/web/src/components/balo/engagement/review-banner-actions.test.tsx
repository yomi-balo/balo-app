import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request', () => ({
  withdrawCompletionRequestAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/accept-project', () => ({
  acceptProjectAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-changes', () => ({
  requestProjectChangesAction: vi.fn(),
}));

import { ReviewBannerActions } from './review-banner-actions';
import { celebrationStorageKey } from './accept-celebration';
import { withdrawCompletionRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request';
import { acceptProjectAction } from '@/app/(dashboard)/engagements/[id]/_actions/accept-project';
import { requestProjectChangesAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-changes';
import { toast } from 'sonner';

const withdrawMock = vi.mocked(withdrawCompletionRequestAction);
const acceptMock = vi.mocked(acceptProjectAction);
const changesMock = vi.mocked(requestProjectChangesAction);

const CLIENT_DECISION = {
  acceptModalBody: "Accepting confirms Priya delivered the project — it can't be un-accepted.",
  requestChangesIntro: 'The project goes back to active with your note attached.',
  requestChangesFieldHint: 'Be specific — this is exactly what Priya sees.',
  milestoneOptions: [
    { id: 'm-1', title: 'Discovery' },
    { id: 'm-2', title: 'Build' },
  ],
  milestoneHelper: 'Milestones you pick go back to Priya with your feedback.',
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  withdrawMock.mockResolvedValue({ success: true });
  acceptMock.mockResolvedValue({ success: true });
  changesMock.mockResolvedValue({ success: true });
});

describe('ReviewBannerActions — admin/expert', () => {
  it('renders nothing for the admin lens', () => {
    const { container } = render(
      <ReviewBannerActions
        lens="admin"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={null}
        initialAction={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('expert lens: opens the modal and calls the withdraw action + toasts on confirm', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="expert"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={null}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Withdraw request/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      screen.getAllByRole('button', { name: /Withdraw request/i }).find((b) => dialog.contains(b))!
    );

    await waitFor(() => {
      expect(withdrawMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
    expect(toast.success).toHaveBeenCalledWith('Completion request withdrawn');
  });
});

describe('ReviewBannerActions — client decision (D7)', () => {
  it('renders Accept project + Request changes buttons', () => {
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );
    expect(screen.getByRole('button', { name: /Accept project/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request changes/i })).toBeInTheDocument();
  });

  it('accept: confirms the sticky modal, calls acceptProjectAction, toasts, arms the celebration', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Accept project/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("can't be un-accepted");
    await user.click(
      screen.getAllByRole('button', { name: /Accept project/i }).find((b) => dialog.contains(b))!
    );

    await waitFor(() => {
      expect(acceptMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
    expect(toast.success).toHaveBeenCalledWith('Project accepted 🎉');
    expect(globalThis.sessionStorage.getItem(celebrationStorageKey('eng-1'))).toBe('1');
  });

  it('request changes: requires a note, then calls requestProjectChangesAction with it', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    const dialog = await screen.findByRole('dialog');
    const send = screen
      .getAllByRole('button', { name: /Send change request/i })
      .find((b) => dialog.contains(b))!;
    expect(send).toBeDisabled(); // empty note

    await user.type(screen.getByLabelText(/What needs to change/i), 'Fix the export totals.');
    expect(send).toBeEnabled();
    await user.click(send);

    await waitFor(() => {
      expect(changesMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        note: 'Fix the export totals.',
        milestoneIds: [],
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Change request sent');
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it('request changes: forwards the ticked milestones in plan order', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    await user.type(await screen.findByLabelText(/What needs to change/i), 'Fix both.');
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    await user.click(screen.getByRole('checkbox', { name: 'Discovery' }));
    await user.click(screen.getByRole('button', { name: /Send change request/i }));

    await waitFor(() => {
      expect(changesMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        note: 'Fix both.',
        milestoneIds: ['m-1', 'm-2'],
      });
    });
  });

  it('request changes: surfaces a rejected request as an error toast', async () => {
    changesMock.mockResolvedValue({ success: false, error: 'The delivery plan changed.' });
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    await user.type(await screen.findByLabelText(/What needs to change/i), 'Fix it.');
    await user.click(screen.getByRole('button', { name: /Send change request/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('The delivery plan changed.');
    });
  });

  it('request changes: a failed send restores the note and ticks on reopen', async () => {
    changesMock.mockResolvedValue({ success: false, error: 'The delivery plan changed.' });
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    await user.type(await screen.findByLabelText(/What needs to change/i), 'Fix it.');
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    await user.click(screen.getByRole('button', { name: /Send change request/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    expect(await screen.findByLabelText(/What needs to change/i)).toHaveValue('Fix it.');
    expect(screen.getByRole('checkbox', { name: 'Build' })).toBeChecked();
  });

  it('request changes: a successful send leaves the form empty on reopen', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction={null}
      />
    );

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    await user.type(await screen.findByLabelText(/What needs to change/i), 'Fix it.');
    await user.click(screen.getByRole('checkbox', { name: 'Build' }));
    await user.click(screen.getByRole('button', { name: /Send change request/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Change request sent'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Request changes/i }));
    expect(await screen.findByLabelText(/What needs to change/i)).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Build' })).not.toBeChecked();
  });

  it('auto-opens the accept modal from the ?action=accept deep-link', async () => {
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction="accept"
      />
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Accept this project');
  });

  it('auto-opens the request-changes modal from the ?action=request-changes deep-link', async () => {
    render(
      <ReviewBannerActions
        lens="client"
        engagementId="eng-1"
        clientCompanyName="Northwind"
        clientDecision={CLIENT_DECISION}
        initialAction="request-changes"
      />
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Request changes');
  });
});
