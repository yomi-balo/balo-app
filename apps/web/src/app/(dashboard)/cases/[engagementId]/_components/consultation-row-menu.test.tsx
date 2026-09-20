import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { CaseConsultationRowView } from '@/lib/cases/case-view-types';
import { ConsultationRowMenu } from './consultation-row-menu';

function makeRow(over: Partial<CaseConsultationRowView> = {}): CaseConsultationRowView {
  return {
    meetingId: 'm1',
    ordinal: 2,
    state: 'scheduled',
    scheduledStartIso: '2026-09-21T18:00:00.000Z',
    startedAtIso: null,
    durationMinutes: null,
    recapHref: null,
    actionItemCount: 0,
    fileCount: 0,
    hasTranscript: false,
    hasRecording: false,
    canReschedule: false,
    canProposeReschedule: false,
    canCancel: false,
    canInvite: false,
    guestCount: 0,
    scheduledMinutes: 30,
    live: false,
    ...over,
  };
}

describe('ConsultationRowMenu', () => {
  it('renders NO trigger when every flag is false — an absent action beats a dead one', () => {
    render(<ConsultationRowMenu row={makeRow()} onAction={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a trigger with an aria-label carrying the ABSOLUTE date and time', () => {
    render(<ConsultationRowMenu row={makeRow({ canCancel: true })} onAction={vi.fn()} />);
    const trigger = screen.getByRole('button');
    const label = trigger.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^Actions for consultation on /);
    // The prefix regex alone would still pass with the date dropped, so assert it explicitly
    // too; this suite runs `TZ=UTC`, matching the fixture's `2026-09-21T18:00:00.000Z`.
    expect(label).toContain('21 Sep');
    expect(label).toContain('6:00');
    expect(label).not.toMatch(/tomorrow|today/i);
  });

  it('opens to show ONLY "Cancel consultation" when canCancel is the only true flag', async () => {
    const user = userEvent.setup();
    render(<ConsultationRowMenu row={makeRow({ canCancel: true })} onAction={vi.fn()} />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: 'Cancel consultation' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reschedule' })).not.toBeInTheDocument();
    // ⚠ Never bare "Cancel" — inside a menu that reads as "close this menu".
    expect(screen.queryByRole('menuitem', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('renders Reschedule and Cancel, in that fixed order, for a client-actionable row', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu
        row={makeRow({ canReschedule: true, canCancel: true })}
        onAction={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Reschedule', 'Cancel consultation']);
  });

  it('renders "Propose a new time" and Cancel for an expert-actionable row', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu
        row={makeRow({ canProposeReschedule: true, canCancel: true })}
        onAction={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Propose a new time', 'Cancel consultation']);
  });

  it('never renders Reschedule and Propose together — the two axes are mutually exclusive per row', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu
        row={makeRow({ canReschedule: true, canProposeReschedule: true, canCancel: true })}
        onAction={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button'));
    // Structurally unreachable on a real row (client/expert axes are exclusive per lens), but
    // the component renders whatever the flags say, so a caller-side regression is caught here.
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Reschedule', 'Propose a new time', 'Cancel consultation']);
  });

  it('calls onAction with the verb, the row, and the "menu" slot when a menu item is chosen', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const row = makeRow({ canReschedule: true, canCancel: true });
    render(<ConsultationRowMenu row={row} onAction={onAction} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: 'Reschedule' }));
    expect(onAction).toHaveBeenCalledWith('reschedule', row, 'menu');
  });

  it('calls onAction with "cancel" and the "menu" slot for the destructive item', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const row = makeRow({ canCancel: true });
    render(<ConsultationRowMenu row={row} onAction={onAction} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: 'Cancel consultation' }));
    expect(onAction).toHaveBeenCalledWith('cancel', row, 'menu');
  });

  it('registers and unregisters the trigger node for focus restoration', () => {
    const registerTrigger = vi.fn();
    const { unmount } = render(
      <ConsultationRowMenu
        row={makeRow({ canCancel: true })}
        onAction={vi.fn()}
        registerTrigger={registerTrigger}
      />
    );
    expect(registerTrigger).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
    unmount();
    expect(registerTrigger).toHaveBeenLastCalledWith(null);
  });

  it('renders "Invite a colleague" first, with the UserPlus icon, and its exact label', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu row={makeRow({ canInvite: true, canCancel: true })} onAction={vi.fn()} />
    );
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Invite a colleague',
      'Cancel consultation',
    ]);
    expect(items[0]?.querySelector('svg.lucide-user-plus')).not.toBeNull();
  });

  it('calls onAction with "invite" and the "menu" slot when the kebab opens it (F5)', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const row = makeRow({ canInvite: true });
    render(<ConsultationRowMenu row={row} onAction={onAction} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: 'Invite a colleague' }));
    expect(onAction).toHaveBeenCalledWith('invite', row, 'menu');
  });

  it('is ABSENT — never disabled — when canInvite is false', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu
        row={makeRow({ canInvite: false, canCancel: true })}
        onAction={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('all four flags true ⇒ four items with the separator immediately before "Cancel consultation"', async () => {
    const user = userEvent.setup();
    render(
      <ConsultationRowMenu
        row={makeRow({
          canInvite: true,
          canReschedule: true,
          canProposeReschedule: true,
          canCancel: true,
        })}
        onAction={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button'));
    const menu = screen.getByRole('menu');
    const rows = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')
    );
    expect(
      rows.map((node) =>
        node.getAttribute('role') === 'separator' ? 'separator' : node.textContent
      )
    ).toEqual([
      'Invite a colleague',
      'Reschedule',
      'Propose a new time',
      'separator',
      'Cancel consultation',
    ]);
  });

  it('canInvite ALONE is enough to render the kebab', () => {
    render(<ConsultationRowMenu row={makeRow({ canInvite: true })} onAction={vi.fn()} />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});
