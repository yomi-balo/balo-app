import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { BaloPanelView } from '@/lib/project-request/load-balo-panel';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockAssignRequestOwner = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/assign-request-owner', () => ({
  assignRequestOwnerAction: (...a: unknown[]) => mockAssignRequestOwner(...a),
}));

const mockCreateInternalNote = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/create-internal-note', () => ({
  createInternalNoteAction: (...a: unknown[]) => mockCreateInternalNote(...a),
}));

const mockDeleteInternalNote = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/delete-internal-note', () => ({
  deleteInternalNoteAction: (...a: unknown[]) => mockDeleteInternalNote(...a),
}));

import { BaloPanel } from './balo-panel';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const STAFF_A_ID = 'b0000000-0000-4000-8000-000000000002';
const STAFF_B_ID = 'b0000000-0000-4000-8000-000000000003';

// Radix Select drives the open/select interaction through Pointer Capture APIs jsdom doesn't
// implement — stub them so the listbox can open (the `changes-modal.test.tsx` precedent).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function view(overrides: Partial<BaloPanelView> = {}): BaloPanelView {
  return {
    owner: null,
    staff: [
      { userId: STAFF_A_ID, name: 'Adeeb Khan' },
      { userId: STAFF_B_ID, name: 'Priya Nair' },
    ],
    notes: [],
    canAssignOwner: true,
    canWriteNotes: true,
    canDeleteAnyNote: false,
    ...overrides,
  };
}

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BaloPanel', () => {
  it('renders the "Balo · Staff only" header', () => {
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);
    expect(screen.getByText('Balo')).toBeInTheDocument();
    expect(screen.getByText('Staff only')).toBeInTheDocument();
  });

  it('renders the D12 two-line empty state when there are no notes', () => {
    render(<BaloPanel requestId={REQUEST_ID} view={view({ notes: [] })} />);
    expect(screen.getByText('No notes yet')).toBeInTheDocument();
    expect(
      screen.getByText('What should the next person at Balo know about this request?')
    ).toBeInTheDocument();
  });

  it('renders notes newest-first with "@ Balo" attribution', () => {
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          notes: [
            {
              id: 'note-1',
              authorName: 'Adeeb Khan',
              authorInitials: 'AK',
              body: 'Waiting on the client.',
              createdAtIso: new Date().toISOString(),
              canDelete: true,
            },
          ],
        })}
      />
    );
    expect(screen.getByText('Adeeb Khan @ Balo')).toBeInTheDocument();
    expect(screen.getByText('Waiting on the client.')).toBeInTheDocument();
  });

  it('hides the trash icon when canDelete is false', () => {
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          notes: [
            {
              id: 'note-1',
              authorName: 'Priya Nair',
              authorInitials: 'PN',
              body: 'Left by someone else.',
              createdAtIso: new Date().toISOString(),
              canDelete: false,
            },
          ],
        })}
      />
    );
    expect(screen.queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  it('shows the trash icon when canDelete is true', () => {
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          notes: [
            {
              id: 'note-1',
              authorName: 'Adeeb Khan',
              authorInitials: 'AK',
              body: 'My own note.',
              createdAtIso: new Date().toISOString(),
              canDelete: true,
            },
          ],
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
  });

  it('hides the entire notes section — label, empty state, and composer — when canWriteNotes is false', () => {
    render(<BaloPanel requestId={REQUEST_ID} view={view({ canWriteNotes: false })} />);
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Add a note for the team')).not.toBeInTheDocument();
  });

  it('shows the composer when canWriteNotes is true, with Add disabled under 3 characters', async () => {
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);
    const textarea = screen.getByPlaceholderText('Add a note for the team');
    const addButton = screen.getByRole('button', { name: /add/i });
    expect(addButton).toBeDisabled();

    await user.type(textarea, 'hi');
    expect(addButton).toBeDisabled();

    await user.type(textarea, ' there');
    expect(addButton).not.toBeDisabled();
  });

  it('adds a note, updates the list, toasts, and fires INTERNAL_NOTE_CREATED', async () => {
    mockCreateInternalNote.mockResolvedValue({
      success: true,
      note: {
        id: 'note-new',
        authorName: 'Adeeb Khan',
        authorInitials: 'AK',
        body: 'A fresh note',
        createdAtIso: new Date().toISOString(),
        canDelete: true,
      },
      analytics: { entityType: 'project_request', entityId: REQUEST_ID },
    });
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);

    await user.type(screen.getByPlaceholderText('Add a note for the team'), 'A fresh note');
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(mockCreateInternalNote).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      body: 'A fresh note',
    });
    expect(await screen.findByText('A fresh note')).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Note added');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.INTERNAL_NOTE_CREATED, {
      entity_type: 'project_request',
      entity_id: REQUEST_ID,
    });
  });

  it('shows an inline error and keeps the draft on a failed note submit', async () => {
    mockCreateInternalNote.mockResolvedValue({ success: false, error: 'Could not add the note.' });
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);

    await user.type(screen.getByPlaceholderText('Add a note for the team'), 'A fresh note');
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(await screen.findByText('Could not add the note.')).toBeInTheDocument();
    expect(mockToast.error).toHaveBeenCalledWith('Could not add the note.');
    expect(screen.getByPlaceholderText('Add a note for the team')).toHaveValue('A fresh note');
  });

  it('announces the note error via role="alert" and links it to the textarea with aria-describedby', async () => {
    mockCreateInternalNote.mockResolvedValue({ success: false, error: 'Could not add the note.' });
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);

    const textarea = screen.getByPlaceholderText('Add a note for the team');
    expect(textarea).toHaveAttribute('aria-invalid', 'false');
    expect(textarea).not.toHaveAttribute('aria-describedby');

    await user.type(textarea, 'A fresh note');
    await user.click(screen.getByRole('button', { name: /add/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not add the note.');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAttribute('aria-describedby', alert.id);
  });

  it('deletes a note via the confirm dialog and fires no analytics (delete has none)', async () => {
    mockDeleteInternalNote.mockResolvedValue({ success: true, noteId: 'note-1' });
    const user = userEvent.setup();
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          notes: [
            {
              id: 'note-1',
              authorName: 'Adeeb Khan',
              authorInitials: 'AK',
              body: 'Delete me',
              createdAtIso: new Date().toISOString(),
              canDelete: true,
            },
          ],
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockDeleteInternalNote).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      noteId: 'note-1',
    });
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Note deleted');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('disables the owner select when canAssignOwner is false', () => {
    render(<BaloPanel requestId={REQUEST_ID} view={view({ canAssignOwner: false })} />);
    expect(screen.getByRole('combobox', { name: 'Balo owner' })).toBeDisabled();
  });

  it('assigns an owner via the select, toasts, and fires REQUEST_OWNER_ASSIGNED when changed', async () => {
    mockAssignRequestOwner.mockResolvedValue({
      success: true,
      owner: { userId: STAFF_A_ID, name: 'Adeeb Khan' },
      changed: true,
      analytics: {
        requestId: REQUEST_ID,
        previousOwnerPresent: false,
        selfAssigned: false,
        cleared: false,
      },
    });
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);

    await user.click(screen.getByRole('combobox', { name: 'Balo owner' }));
    await user.click(screen.getByRole('option', { name: 'Adeeb Khan @ Balo' }));

    expect(mockAssignRequestOwner).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      ownerUserId: STAFF_A_ID,
    });
    expect(mockToast.success).toHaveBeenCalledWith('Adeeb Khan is now the Balo owner');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED, {
      request_id: REQUEST_ID,
      previous_owner_present: false,
      self_assigned: false,
      cleared: false,
    });
  });

  it('clearing an assigned owner (selecting Unassigned) toasts "Owner cleared" and still fires REQUEST_OWNER_ASSIGNED (the CLIENT analytics event covers clear too — D11\'s "no event on clear" is about the notification, a different axis)', async () => {
    mockAssignRequestOwner.mockResolvedValue({
      success: true,
      owner: null,
      changed: true,
      analytics: {
        requestId: REQUEST_ID,
        previousOwnerPresent: true,
        selfAssigned: false,
        cleared: true,
      },
    });
    const user = userEvent.setup();
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({ owner: { userId: STAFF_A_ID, name: 'Adeeb Khan' } })}
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Balo owner' }));
    await user.click(screen.getByRole('option', { name: 'Unassigned' }));

    expect(mockAssignRequestOwner).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      ownerUserId: null,
    });
    expect(mockToast.success).toHaveBeenCalledWith('Owner cleared');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED, {
      request_id: REQUEST_ID,
      previous_owner_present: true,
      self_assigned: false,
      cleared: true,
    });
  });

  it('when the action returns changed:false, the component toasts from the response but never tracks', async () => {
    // The `unchanged` server outcome (re-selecting the current owner) is exercised at the
    // action layer (`assign-request-owner.test.ts`); here the component is driven by a mocked
    // `changed:false` RESPONSE — the click target need not match it — to pin the component's
    // OWN rule: it always renders/toasts off `res`, and gates `track()` on `res.changed` alone.
    mockAssignRequestOwner.mockResolvedValue({
      success: true,
      owner: { userId: STAFF_A_ID, name: 'Adeeb Khan' },
      changed: false,
      analytics: { requestId: REQUEST_ID, previousOwnerPresent: true, selfAssigned: false },
    });
    const user = userEvent.setup();
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({ owner: { userId: STAFF_A_ID, name: 'Adeeb Khan' } })}
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Balo owner' }));
    await user.click(screen.getByRole('option', { name: 'Priya Nair @ Balo' }));

    expect(mockToast.success).toHaveBeenCalledWith('Adeeb Khan is now the Balo owner');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('prepends a demoted owner (absent from staff) so the select renders a value', () => {
    render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          owner: { userId: 'demoted-user', name: 'Demoted Person' },
          staff: [{ userId: STAFF_A_ID, name: 'Adeeb Khan' }],
        })}
      />
    );
    expect(screen.getByText('Demoted Person @ Balo')).toBeInTheDocument();
  });

  it('shows an error toast on a failed owner assignment', async () => {
    mockAssignRequestOwner.mockResolvedValue({
      success: false,
      error: 'That person is not a Balo staff member.',
      code: 'not_staff',
    });
    const user = userEvent.setup();
    render(<BaloPanel requestId={REQUEST_ID} view={view()} />);

    await user.click(screen.getByRole('combobox', { name: 'Balo owner' }));
    await user.click(screen.getByRole('option', { name: 'Adeeb Khan @ Balo' }));

    expect(mockToast.error).toHaveBeenCalledWith('That person is not a Balo staff member.');
  });

  it('never renders a gradient class (no emphasised/promotional action on this panel)', () => {
    const { container } = render(<BaloPanel requestId={REQUEST_ID} view={view()} />);
    expect(container.querySelector('[class*="bg-gradient"]')).toBeNull();
  });

  it('has no accessibility violations in its fullest state (owner set, one note, canDeleteAnyNote true)', async () => {
    const { container } = render(
      <BaloPanel
        requestId={REQUEST_ID}
        view={view({
          owner: { userId: STAFF_A_ID, name: 'Adeeb Khan' },
          notes: [
            {
              id: 'note-1',
              authorName: 'Priya Nair',
              authorInitials: 'PN',
              body: 'Waiting on the client to sign off.',
              createdAtIso: new Date().toISOString(),
              canDelete: true,
            },
          ],
          canDeleteAnyNote: true,
        })}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
