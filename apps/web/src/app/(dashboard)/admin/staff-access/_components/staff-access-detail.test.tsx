import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { StaffAccessPerson } from '@balo/shared/authz';
import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import type { SaveStaffAccessActionResult } from '../_lib/staff-access-outcome';
import { STAFF_ACCESS_SAVE_MESSAGES } from '../_lib/staff-access-outcome';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const mockSaveStaffAccessAction = vi.fn<(input: unknown) => Promise<SaveStaffAccessActionResult>>();
vi.mock('../_actions/save-staff-access', () => ({
  saveStaffAccessAction: (input: unknown) => mockSaveStaffAccessAction(input),
}));

import { StaffAccessDetail } from './staff-access-detail';

function person(overrides: Partial<StaffAccessPerson> = {}): StaffAccessPerson {
  return {
    id: 'target-1',
    firstName: 'Adeeb',
    lastName: 'Rahman',
    email: 'adeeb@example.com',
    role: 'admin',
    customList: null,
    isLive: true,
    emailVerified: true,
    ...overrides,
  };
}

/**
 * A THIRD PARTY floor holder — present in every `people` array below except the floor-specific
 * tests, so changing the TARGET's role never spuriously trips `roleOptionFloorBlocked`/
 * `saveBlockOf` for reasons unrelated to what each test is checking (the floor rule only cares
 * whether SOMEONE keeps it, and this fixture is that someone).
 *
 * ⚠ ITS id IS `viewerId` ("viewer") ON PURPOSE (C4). In production `people` (the roster the page
 * loaded with) always includes the viewer's OWN row — they hold `manage_staff_capabilities` to be
 * here at all — and `saveBlockOf`'s grant ceiling reads the viewer's resolved set from exactly
 * that row. Following the role with `customList: null` resolves the FULL super_admin bundle, so
 * this fixture can grant anything a test promotes someone else to, keeping every test unrelated to
 * C4 unaffected by it. Tests that specifically exercise a RESTRICTED actor build their own.
 */
const FLOOR_HOLDER = person({
  id: 'viewer',
  firstName: 'Priya',
  lastName: 'Okafor',
  email: 'priya@example.com',
  role: 'super_admin',
  customList: null,
  isLive: true,
});

const mockToast = vi.mocked(toast);

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveStaffAccessAction.mockResolvedValue({
    success: true,
    roleChanged: true,
    customListChanged: false,
  });
});

describe('StaffAccessDetail — D3 self read-only', () => {
  it('shows the self banner, disables every control, and renders no action bar', () => {
    const self = person({ id: 'viewer' });
    render(<StaffAccessDetail person={self} people={[self]} viewerId="viewer" />);

    expect(screen.getByText(/you cannot change your own access/i)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
    expect(screen.queryByRole('button', { name: /review and save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });

  it('F9 (U2): a self record in custom mode shows NO capability lock line, even one that would otherwise be a floor lock', () => {
    const self = person({
      id: 'viewer',
      role: 'super_admin',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
      isLive: true,
    });
    render(<StaffAccessDetail person={self} people={[self]} viewerId="viewer" />);

    expect(
      screen.queryByText(/leaves no one able to open this page and manage staff/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/only a super admin can hold this/i)).not.toBeInTheDocument();
  });
});

describe('StaffAccessDetail — ruling 1: role change resets to follow, next Custom pre-fills fresh', () => {
  it('selecting a new role resets to Follow, and Custom then pre-fills from the NEW role', async () => {
    const user = userEvent.setup();
    const admin = person({
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    });
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);

    await user.click(screen.getByRole('radio', { name: /^super admin/i }));
    expect(screen.getByRole('button', { name: 'Follow role' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    expect(
      screen.getByRole('checkbox', { name: /use the product as another person/i })
    ).toBeChecked();
  });
});

describe('StaffAccessDetail — C9: mode toggle focus and tap targets', () => {
  it('Follow role and Custom both meet the 44px minimum and carry a focus-visible ring', () => {
    const admin = person({ role: 'admin', customList: null });
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);

    const followButton = screen.getByRole('button', { name: 'Follow role' });
    const customButton = screen.getByRole('button', { name: 'Custom' });
    expect(followButton).toHaveClass('min-h-[44px]');
    expect(followButton.className).toContain('focus-visible:ring-2');
    expect(customButton).toHaveClass('min-h-[44px]');
    expect(customButton.className).toContain('focus-visible:ring-2');
    // `aria-pressed`, not tab semantics — this is a toggle button pair.
    expect(followButton).toHaveAttribute('aria-pressed');
    expect(customButton).toHaveAttribute('aria-pressed');
  });
});

describe('StaffAccessDetail — F2 (R1): clicking a pressed "Custom" is a no-op', () => {
  it("keeps a stored custom list's checkboxes exactly as they were", async () => {
    const user = userEvent.setup();
    const admin = person({
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    });
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);

    // Already in custom mode (a stored list) — "Custom" is already pressed.
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: /close items in the alert queue/i })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Custom' }));

    expect(screen.getByRole('checkbox', { name: /close items in the alert queue/i })).toBeChecked();
    // Nothing else in the bundle got pulled in by a re-fill.
    expect(
      screen.getByRole('checkbox', { name: /set the balo fee on a project/i })
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });
});

describe('StaffAccessDetail — D9', () => {
  it('Custom is disabled for role "user", with a visible hint', async () => {
    const user = userEvent.setup();
    const admin = person({ role: 'admin', customList: null });
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);

    await user.click(screen.getByRole('radio', { name: /no staff access/i }));
    expect(screen.getByRole('button', { name: 'Custom' })).toBeDisabled();
    expect(
      screen.getByText(/a custom list needs the admin or super admin role/i)
    ).toBeInTheDocument();
  });
});

describe('StaffAccessDetail — floor lock', () => {
  it('locks manage_staff_capabilities for the sole floor holder, with visible copy', async () => {
    const sole = person({
      id: 'sole',
      role: 'super_admin',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
      isLive: true,
    });
    render(<StaffAccessDetail person={sole} people={[sole]} viewerId="viewer" />);

    // Both MANAGE_STAFF_CAPABILITIES and VIEW_PLATFORM_ADMIN are floor-critical for the sole
    // holder — removing either drops the pair, so both rows carry the lock copy.
    expect(
      screen.getAllByText(/leaves no one able to open this page and manage staff/i).length
    ).toBeGreaterThanOrEqual(1);
    const checkbox = screen.getByRole('checkbox', {
      name: /change what other staff can do/i,
    });
    expect(checkbox).toBeDisabled();
  });

  it("blocks demoting the sole floor holder's role, with visible reason naming them", () => {
    const sole = person({
      id: 'sole',
      firstName: 'Priya',
      role: 'super_admin',
      customList: null,
      isLive: true,
    });
    render(<StaffAccessDetail person={sole} people={[sole]} viewerId="viewer" />);
    const adminOption = screen.getByRole('radio', { name: /^admin/i });
    expect(adminOption).toBeDisabled();
    expect(
      within(adminOption).getByText(
        /priya is the only person who can open this page and manage staff/i
      )
    ).toBeInTheDocument();
  });
});

describe('StaffAccessDetail — F1 (S1/S2): a SUSPENDED staff member', () => {
  it('cannot be given a NEW capability — Review and save stays disabled with the ineligible message', async () => {
    const user = userEvent.setup();
    const suspendedAdmin = person({
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
      isLive: false,
    });
    render(
      <StaffAccessDetail
        person={suspendedAdmin}
        people={[suspendedAdmin, FLOOR_HOLDER]}
        viewerId="viewer"
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /create and manage promo codes/i }));

    expect(screen.getByRole('button', { name: /review and save/i })).toBeDisabled();
    expect(screen.getByText(STAFF_ACCESS_SAVE_MESSAGES.target_ineligible)).toBeInTheDocument();
  });

  it('CAN be trimmed — removing a held capability is a pure reduction, still saveable', async () => {
    const user = userEvent.setup();
    const suspendedAdmin = person({
      role: 'admin',
      customList: [
        PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
        PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
      ],
      isLive: false,
    });
    render(
      <StaffAccessDetail
        person={suspendedAdmin}
        people={[suspendedAdmin, FLOOR_HOLDER]}
        viewerId="viewer"
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /create and manage promo codes/i }));

    expect(screen.getByRole('button', { name: /review and save/i })).not.toBeDisabled();
    expect(
      screen.queryByText(STAFF_ACCESS_SAVE_MESSAGES.target_ineligible)
    ).not.toBeInTheDocument();
  });
});

describe('StaffAccessDetail — C4: an actor may only grant what the actor holds', () => {
  // A genuine THIRD PARTY floor holder, distinct from the restricted viewer under test, so every
  // assertion below isolates the ceiling from D2's floor (which otherwise would ALSO fire here,
  // since neither the target nor the restricted viewer holds the floor tokens).
  const thirdPartyFloorHolder = person({
    id: 'third-party',
    role: 'super_admin',
    customList: null,
  });

  it('adding a capability the viewer does not resolve disables Review and save, with the ceiling copy', async () => {
    const user = userEvent.setup();
    // Overrides the shared full-bundle `FLOOR_HOLDER`/viewer fixture with a RESTRICTED one that
    // cannot grant MANAGE_PROMO_CODES.
    const restrictedViewer = person({
      id: 'viewer',
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
      isLive: true,
    });
    const admin = person({
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    });
    render(
      <StaffAccessDetail
        person={admin}
        people={[admin, restrictedViewer, thirdPartyFloorHolder]}
        viewerId="viewer"
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /create and manage promo codes/i }));

    expect(screen.getByRole('button', { name: /review and save/i })).toBeDisabled();
    expect(screen.getByText(STAFF_ACCESS_SAVE_MESSAGES.grant_exceeds_actor)).toBeInTheDocument();
  });

  it('removing a capability by a restricted viewer stays saveable — the ceiling never blocks a reduction', async () => {
    const user = userEvent.setup();
    const restrictedViewer = person({
      id: 'viewer',
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
      isLive: true,
    });
    const admin = person({
      role: 'admin',
      customList: [
        PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
        PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
      ],
    });
    render(
      <StaffAccessDetail
        person={admin}
        people={[admin, restrictedViewer, thirdPartyFloorHolder]}
        viewerId="viewer"
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /create and manage promo codes/i }));

    expect(screen.getByRole('button', { name: /review and save/i })).not.toBeDisabled();
    expect(
      screen.queryByText(STAFF_ACCESS_SAVE_MESSAGES.grant_exceeds_actor)
    ).not.toBeInTheDocument();
  });
});

describe('StaffAccessDetail — token id shown as secondary text', () => {
  it('renders the raw token id alongside the human name', () => {
    const admin = person();
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);
    expect(screen.getByText(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS)).toBeInTheDocument();
  });
});

describe('StaffAccessDetail — Discard', () => {
  it('is disabled until dirty, and reverts the draft on click', async () => {
    const user = userEvent.setup();
    const admin = person({ role: 'admin', customList: null });
    render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);

    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /^super admin/i }));
    expect(screen.getByRole('button', { name: /discard/i })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByRole('radio', { name: /^admin/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });
});

/**
 * Shared setup for every test below: an admin promoted to super_admin, with the confirm dialog
 * already open (mirrors clicking "Review and save"). Extracted because jscpd flagged this exact
 * sequence repeated across five tests in this describe block — a DRY fix, not a behavior change;
 * each test still drives `user` itself from here (clicking "Save changes", Escape, Cancel, …).
 * Any mock on `mockSaveStaffAccessAction` a test needs may be set before OR after calling this —
 * `render`/opening the dialog never calls the save action, only "Save changes" does.
 */
async function renderAtConfirmStep(): Promise<{
  readonly user: ReturnType<typeof userEvent.setup>;
}> {
  const user = userEvent.setup();
  const admin = person({ role: 'admin', customList: null });
  render(<StaffAccessDetail person={admin} people={[admin, FLOOR_HOLDER]} viewerId="viewer" />);
  await user.click(screen.getByRole('radio', { name: /^super admin/i }));
  await user.click(screen.getByRole('button', { name: /review and save/i }));
  return { user };
}

describe('StaffAccessDetail — confirm dialog diff and save outcomes', () => {
  it('shows the capability diff in the confirm dialog', async () => {
    await renderAtConfirmStep();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(
      screen.getByText(/use the product as another person/i, { selector: 'li *' })
    ).toBeInTheDocument();
  });

  it('shows a success toast and closes the dialog on a successful save', async () => {
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Access updated for Adeeb');
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('C8: cannot be dismissed (Escape) while the save is in flight, but CAN once it fails', async () => {
    let resolveSave: (value: SaveStaffAccessActionResult) => void = () => {
      throw new Error('resolveSave called before assignment');
    };
    mockSaveStaffAccessAction.mockImplementation(
      () =>
        new Promise<SaveStaffAccessActionResult>((resolve) => {
          resolveSave = resolve;
        })
    );
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The save is still in flight (the mock promise has not been resolved yet) — Escape must
    // not close the dialog.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    resolveSave({ success: false, code: 'no_change', error: STAFF_ACCESS_SAVE_MESSAGES.no_change });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(STAFF_ACCESS_SAVE_MESSAGES.no_change);
    });

    // The save has settled (failed) and the banner is showing — it CAN be dismissed now.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('N4: a REJECTED save (not a typed refusal) shows the generic failed banner, and Escape can close it', async () => {
    mockSaveStaffAccessAction.mockRejectedValueOnce(new Error('network down'));
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(STAFF_ACCESS_SAVE_MESSAGES.failed);
    });

    // `saving` must not be stuck true after a rejection — Escape closes the dialog.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('N4: a REJECTED save also allows Cancel once the banner is showing', async () => {
    mockSaveStaffAccessAction.mockRejectedValueOnce(new Error('network down'));
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(STAFF_ACCESS_SAVE_MESSAGES.failed);
    });

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('a stale refusal shows the reload banner, and Reload calls router.refresh', async () => {
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'stale',
      error: STAFF_ACCESS_SAVE_MESSAGES.stale,
    });
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/changed since you opened it/i);
    });
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('F3 (R2): cancelling a failed save, editing further, and reopening shows NO old banner', async () => {
    mockSaveStaffAccessAction.mockResolvedValue({
      success: false,
      code: 'no_change',
      error: STAFF_ACCESS_SAVE_MESSAGES.no_change,
    });
    const { user } = await renderAtConfirmStep();
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(STAFF_ACCESS_SAVE_MESSAGES.no_change);
    });

    // Cancel the dialog (Radix AlertDialog's Cancel action) without a new save.
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    // Edit the draft further, then reopen "Review and save" — the stale banner must be gone.
    await user.click(screen.getByRole('radio', { name: /^admin/i }));
    await user.click(screen.getByRole('radio', { name: /^super admin/i }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
