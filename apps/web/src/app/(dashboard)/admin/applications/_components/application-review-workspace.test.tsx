import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import type { EditApplicationActionResult } from '../_actions/_shared/edit-outcome';
import type { ExpertApplicationEditSection } from '@balo/shared/experts';

/**
 * `ApplicationEditForm` / `EditSaveBar` / `DiscardChangesDialog` are stubbed down to
 * the minimum surface this component drives (props in, a couple of buttons out) so this suite
 * exercises `ApplicationReviewWorkspace`'s own state machine — the save/cancel/discard flow and
 * the unsaved-changes guard — not F's rendering.
 */
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
}));

const mockEditAction = vi.fn<(input: unknown) => Promise<EditApplicationActionResult>>();
vi.mock('../_actions/edit-expert-application', () => ({
  editExpertApplicationAction: (input: unknown) => mockEditAction(input),
}));

const mockDescribeChanges = vi.fn<() => { section: string; text: string }[]>(() => []);
// Defaults to `null` (no error), same as the REAL function's
// no-touched/valid-pair outcome, so every pre-existing test here keeps its prior behaviour.
const mockStaffEditExperienceError = vi.fn<() => string | null>(() => null);
vi.mock('../_lib/staff-edit-model', () => ({
  buildStaffEdit: vi.fn(() => ({})),
  describeStaffEditChanges: (...args: unknown[]) => mockDescribeChanges(...(args as [])),
  staffEditExperienceError: (...args: unknown[]) => mockStaffEditExperienceError(...(args as [])),
}));

vi.mock('./edit/application-edit-form', () => ({
  ApplicationEditForm: ({
    draft,
    onChange,
    disabled,
  }: {
    draft: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onChange({ ...draft, touched: true })}>
      change a field
    </button>
  ),
}));

vi.mock('./edit/edit-save-bar', () => ({
  EditSaveBar: ({
    changes,
    saving,
    live,
    firstName,
    onCancel,
    onSave,
    disableSave,
  }: {
    changes: { section: string; text: string }[];
    saving: boolean;
    live: boolean;
    firstName: string;
    onCancel: () => void;
    onSave: () => void;
    disableSave?: boolean;
  }) => (
    <div>
      <span data-testid="change-count">{changes.length}</span>
      <span data-testid="live">{live ? 'live' : 'pending'}</span>
      <span data-testid="first-name">{firstName}</span>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" disabled={saving || disableSave} onClick={onSave}>
        Save changes
      </button>
    </div>
  ),
}));

vi.mock('./edit/discard-changes-dialog', () => ({
  DiscardChangesDialog: ({
    open,
    onKeep,
    onDiscard,
  }: {
    open: boolean;
    onKeep: () => void;
    onDiscard: () => void;
  }) =>
    open ? (
      <div role="alertdialog">
        <button type="button" onClick={onKeep}>
          Keep editing
        </button>
        <button type="button" onClick={onDiscard}>
          Discard changes
        </button>
      </div>
    ) : null,
}));

vi.mock('./decision-controls', () => ({
  DecisionControls: () => <div data-testid="decision-controls">DecisionControls</div>,
}));

import { ApplicationReviewWorkspace } from './application-review-workspace';
import { ApplicationSections, WorkHistorySection } from './application-sections';
import type { StaffEditModel, StaffEditReference } from '../_lib/staff-edit-model';
import type { ApplicationWithRelations } from '@balo/db';

const EDIT_MODEL = { marker: 'initial' } as unknown as StaffEditModel;
const REFERENCE = {} as unknown as StaffEditReference;
const PROFILE_ID = '11111111-1111-1111-1111-111111111111';

const APPLICATION_WITH_WORK_HISTORY = {
  profile: {
    id: 'p1',
    yearStartedSalesforce: 2018,
    projectCountMin: 10,
    projectLeadCountMin: 1,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  user: {
    id: 'u1',
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'priya@example.com',
    avatarUrl: null,
    phone: null,
    timezone: null,
    country: null,
    countryCode: null,
    deletedAt: null,
  },
  agency: null,
  competencies: [],
  certifications: [],
  languages: [],
  industries: [],
  workHistory: [
    {
      id: 'w1',
      role: 'Lead Consultant',
      company: 'Northwind',
      startedAt: new Date('2017-11-01T00:00:00.000Z'),
      endedAt: new Date('2020-04-01T00:00:00.000Z'),
      isCurrent: false,
      responsibilities: null,
    },
  ],
} as unknown as ApplicationWithRelations;

function renderWorkspace(
  overrides: Partial<React.ComponentProps<typeof ApplicationReviewWorkspace>> = {}
) {
  return render(
    <ApplicationReviewWorkspace
      expertProfileId={PROFILE_ID}
      firstName="Priya"
      isPending={true}
      canEdit={true}
      live={false}
      headerSummary={<div>Header</div>}
      banner={null}
      readSections={<div data-testid="read-sections">Read sections</div>}
      workHistory={<div data-testid="work-history">Work history</div>}
      editModel={EDIT_MODEL}
      reference={REFERENCE}
      {...overrides}
    />
  );
}

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
  mockDescribeChanges.mockReturnValue([]);
  mockStaffEditExperienceError.mockReturnValue(null);
});

describe('ApplicationReviewWorkspace', () => {
  /**
   * Work history arrives only through the `workHistory` slot; `ApplicationSections` must not
   * render its own copy, or read mode shows it twice. Uses the REAL `ApplicationSections` /
   * `WorkHistorySection` (not the stubs the rest of this file uses) so a duplicate is observable.
   */
  it('renders exactly one "Work history" heading in read mode and in edit mode', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      readSections: (
        <ApplicationSections
          application={APPLICATION_WITH_WORK_HISTORY}
          productsByCategory={[]}
          supportTypes={[]}
          certificationsByCategory={[]}
          selfRatings={[]}
          skillsLocked={false}
        />
      ),
      workHistory: <WorkHistorySection entries={APPLICATION_WITH_WORK_HISTORY.workHistory} />,
    });

    expect(screen.getAllByText('Work history')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /edit application/i }));

    expect(screen.getAllByText('Work history')).toHaveLength(1);
  });

  it('shows no Edit button when canEdit is false', () => {
    renderWorkspace({ canEdit: false });
    expect(screen.queryByRole('button', { name: /edit application/i })).toBeNull();
  });

  it('shows Edit application and DecisionControls together in read mode', () => {
    renderWorkspace();
    expect(screen.getByRole('button', { name: /edit application/i })).toBeInTheDocument();
    expect(screen.getByTestId('decision-controls')).toBeInTheDocument();
    expect(screen.getByTestId('read-sections')).toBeInTheDocument();
  });

  it('entering edit mode hides Approve/Decline (DecisionControls) and shows the Editing pill', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));

    expect(screen.queryByTestId('decision-controls')).toBeNull();
    expect(screen.getByText('Editing')).toBeInTheDocument();
    expect(screen.queryByTestId('read-sections')).toBeNull();
  });

  it('cancel with no changes exits edit mode without opening the discard dialog', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('read-sections')).toBeInTheDocument();
  });

  it('cancel after a change opens the discard dialog, and Discard restores read mode', async () => {
    const user = userEvent.setup();
    mockDescribeChanges.mockReturnValue([{ section: 'Ratings', text: 'Config: 5 → 8' }]);
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('read-sections')).toBeInTheDocument();
  });

  it('a successful live save tracks analytics and shows the live toast copy', async () => {
    const user = userEvent.setup();
    mockDescribeChanges.mockReturnValue([{ section: 'Ratings', text: 'Config: 5 → 8' }]);
    const analytics = {
      status: 'approved' as const,
      sections: ['ratings'] as ExpertApplicationEditSection[],
      ratings_adjusted: 1,
      products_added: 0,
      products_removed: 0,
      certifications_added: 0,
      certifications_removed: 0,
    };
    mockEditAction.mockResolvedValue({ success: true, changed: true, live: true, analytics });
    renderWorkspace({ live: true });

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockEditAction).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: PROFILE_ID })
    );
    expect(mockTrack).toHaveBeenCalledWith(ADMIN_APPLICATIONS_EVENTS.EDITED, analytics);
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('updated and they'));
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByTestId('read-sections')).toBeInTheDocument();
  });

  it('a not_editable failure exits edit mode and toasts an error', async () => {
    const user = userEvent.setup();
    mockDescribeChanges.mockReturnValue([{ section: 'Ratings', text: 'Config: 5 → 8' }]);
    mockEditAction.mockResolvedValue({
      success: false,
      error: 'That application can no longer be edited.',
      code: 'not_editable',
    });
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringContaining('declined while you were editing')
    );
    expect(screen.getByTestId('read-sections')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('a generic failure stays in edit mode and never refreshes', async () => {
    const user = userEvent.setup();
    mockDescribeChanges.mockReturnValue([{ section: 'Ratings', text: 'Config: 5 → 8' }]);
    mockEditAction.mockResolvedValue({ success: false, error: 'Invalid request.' });
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockToast.error).toHaveBeenCalledWith('Invalid request.');
    expect(screen.queryByTestId('read-sections')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * The repository's OWN refusal, surfaced through its
   * dedicated `code`/message pair rather than the generic failure copy.
   */
  it('toasts the invalid_experience message by code, and never refreshes', async () => {
    const user = userEvent.setup();
    mockDescribeChanges.mockReturnValue([
      { section: 'Experience', text: 'Projects as lead 1 → 10' },
    ]);
    mockEditAction.mockResolvedValue({
      success: false,
      error: "Projects led can't be more than total projects. Nothing was written.",
      code: 'invalid_experience',
    });
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockToast.error).toHaveBeenCalledWith(
      "Projects led can't be more than total projects. Nothing was written."
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * Computed ONCE and passed down; Save stays disabled even
   * though `changes` is non-empty, so a staffer can't submit a delta that will be refused anyway.
   */
  it('disables Save while staffEditExperienceError is non-null, even with changes', async () => {
    mockDescribeChanges.mockReturnValue([
      { section: 'Experience', text: 'Projects as lead 1 → 10' },
    ]);
    mockStaffEditExperienceError.mockReturnValue("Projects led can't be more than total projects.");
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole('button', { name: /edit application/i }));
    await user.click(screen.getByRole('button', { name: 'change a field' }));

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(mockEditAction).not.toHaveBeenCalled();
  });
});
