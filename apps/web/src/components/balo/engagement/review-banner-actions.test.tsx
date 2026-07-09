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
};

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
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
    expect(window.sessionStorage.getItem(celebrationStorageKey('eng-1'))).toBe('1');
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
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Change request sent');
    expect(acceptMock).not.toHaveBeenCalled();
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
