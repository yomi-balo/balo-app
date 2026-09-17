import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { StaffAccessPerson } from '@balo/shared/authz';
import type {
  FindStaffCandidateActionResult,
  SaveStaffAccessActionResult,
} from '../_lib/staff-access-outcome';
import { STAFF_CANDIDATE_MESSAGES } from '../_lib/staff-access-outcome';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const mockFindStaffCandidateAction =
  vi.fn<(input: unknown) => Promise<FindStaffCandidateActionResult>>();
vi.mock('../_actions/find-staff-candidate', () => ({
  findStaffCandidateAction: (input: unknown) => mockFindStaffCandidateAction(input),
}));

const mockSaveStaffAccessAction = vi.fn<(input: unknown) => Promise<SaveStaffAccessActionResult>>();
vi.mock('../_actions/save-staff-access', () => ({
  saveStaffAccessAction: (input: unknown) => mockSaveStaffAccessAction(input),
}));

import { AddStaffDialog } from './add-staff-dialog';

const CANDIDATE: StaffAccessPerson = {
  id: 'candidate-1',
  firstName: 'Priya',
  lastName: 'Shah',
  email: 'priya@example.com',
  role: 'user',
  customList: null,
  isLive: true,
  emailVerified: true,
};

const EXISTING: StaffAccessPerson = {
  id: 'existing-1',
  firstName: 'Luke',
  lastName: 'Brennan',
  email: 'luke@example.com',
  role: 'admin',
  customList: null,
  emailVerified: true,
  isLive: true,
};

const mockToast = vi.mocked(toast);

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddStaffDialog>> = {}) {
  return render(
    <AddStaffDialog open onOpenChange={vi.fn()} onSelectPerson={vi.fn()} {...overrides} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddStaffDialog — lookup step', () => {
  it('shows an inline error for a partial address, without calling the action', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/email they signed up with/i), 'dana@');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    expect(screen.getByText(STAFF_CANDIDATE_MESSAGES.invalid)).toBeInTheDocument();
    expect(mockFindStaffCandidateAction).not.toHaveBeenCalled();
  });

  it('shows the generic not_found message and nothing else', async () => {
    const user = userEvent.setup();
    mockFindStaffCandidateAction.mockResolvedValue({
      success: false,
      code: 'not_found',
      error: STAFF_CANDIDATE_MESSAGES.not_found,
    });
    renderDialog();
    await user.type(screen.getByLabelText(/email they signed up with/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => {
      expect(screen.getByText(STAFF_CANDIDATE_MESSAGES.not_found)).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('shows the error and toasts for denied/failed', async () => {
    const user = userEvent.setup();
    mockFindStaffCandidateAction.mockResolvedValue({
      success: false,
      code: 'failed',
      error: STAFF_CANDIDATE_MESSAGES.failed,
    });
    renderDialog();
    await user.type(screen.getByLabelText(/email they signed up with/i), 'dana@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(STAFF_CANDIDATE_MESSAGES.failed);
    });
  });

  it('found + already staff (C2 part 1: classified from the FRESH lookup, never a roster prop) shows the "already has staff access" card, and Open refreshes, selects + closes (C2 part 2)', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    const onOpenChange = vi.fn();
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: EXISTING });
    renderDialog({ onSelectPerson, onOpenChange });

    await user.type(screen.getByLabelText(/email they signed up with/i), 'luke@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));

    await waitFor(() => {
      expect(screen.getByText(/already has staff access/i)).toBeInTheDocument();
    });
    // It must NOT have advanced to the promote step (which would re-grant a fresh role).
    expect(screen.queryByText(/give .* staff access$/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open their access/i }));
    // C2 part 2 — refresh before selecting, so a stale detail pane is not left empty.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onSelectPerson).toHaveBeenCalledWith('existing-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('found + not on the roster advances to the promote step', async () => {
    const user = userEvent.setup();
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    renderDialog();

    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));

    await waitFor(() => {
      expect(screen.getByText('Give Priya Shah staff access')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('radio')).toHaveLength(2); // Admin and Super admin only
  });
});

describe('AddStaffDialog — promote and confirm steps', () => {
  it('shows the confirm summary and saves with the selected role, null customList', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    mockSaveStaffAccessAction.mockResolvedValue({
      success: true,
      roleChanged: true,
      customListChanged: false,
    });
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    renderDialog({ onSelectPerson });
    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));

    expect(screen.getByText(/give priya shah staff access\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      // C2 part 3 — `expected` is the flow's own premise (a plain user), a literal pin, never
      // read off `candidate.role`/`candidate.customList`: if the candidate is no longer a plain
      // user by the time this save lands, the server's D6 stale check refuses it.
      expect(mockSaveStaffAccessAction).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: 'candidate-1',
          expected: { role: 'user', customList: null },
          next: { role: 'admin', customList: null },
        })
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith('Priya Shah now has staff access');
    expect(onSelectPerson).toHaveBeenCalledWith('candidate-1');
  });

  it('a failed save shows the inline error and does not close', async () => {
    const user = userEvent.setup();
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'floor_violation',
      error: 'Someone must still be able to open this page and manage staff.',
    });
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/must still be able to open this page/i);
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('N2: fail, go Back, pick another role, Review and save shows no stale banner', async () => {
    const user = userEvent.setup();
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'floor_violation',
      error: 'Someone must still be able to open this page and manage staff.',
    });
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    renderDialog();
    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /back/i }));
    await user.click(screen.getByRole('radio', { name: /^super admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('F4 (R3): a stale save failure shows Reload, and clicking it calls router.refresh and closes', async () => {
    const user = userEvent.setup();
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'stale',
      error: "This person's access changed since you opened it.",
    });
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a non-reload failure (e.g. denied) renders no Reload button', async () => {
    const user = userEvent.setup();
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'denied',
      error: 'You do not have permission to do this.',
    });
    mockFindStaffCandidateAction.mockResolvedValue({ success: true, person: CANDIDATE });
    renderDialog();
    await user.type(screen.getByLabelText(/email they signed up with/i), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: /find account/i }));
    await waitFor(() => screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
  });
});
