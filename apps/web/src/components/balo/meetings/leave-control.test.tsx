import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { LeaveControl, type LeaveControlProps } from './leave-control';

/**
 * BAL-435 — ⚠⚠ **THE PINNED FINDING.**
 *
 * The prototype gated end-for-everyone on `lens === 'expert'`. Two defects: a LENS is never an
 * authorization input (ADR-1029), and leaving was conflated with ending, so a host stepping out
 * to take a phone call would have hung up on their client.
 *
 * ⚠ THE HEADLINE ASSERTION IS AN **ABSENCE**, AND IT IS DELIBERATELY MADE TWICE — once through
 * the accessible tree (`queryByRole`) and once as a raw text sweep. A control that is merely
 * unqueryable is not absent: `hidden` markup, an `aria-label` or a `sr-only` string would each
 * pass one of those checks and fail the other. A disabled control would pass BOTH `queryByRole`
 * variants that don't check `disabled`, which is why "not disabled, ABSENT" is the wording of the
 * rule.
 *
 * ⚠ THE VENDOR CALL ITSELF (`updateParticipants({'*':{eject:true}})` then `leave()`) IS ASSERTED
 * IN `meeting-call-surface.test.tsx`, NOT HERE, AND THAT IS ON PURPOSE. `LeaveControl` imports
 * nothing from `@daily-co` — it raises `onEndForEveryone` and the frame performs the eject. A
 * test that asserted a Daily call at this level could only do it by mocking the callback into
 * something that isn't the production path, which would prove nothing.
 */

// ⚠ jsdom has no `matchMedia` and `setup.ts` stubs none, so the hook is mocked directly — the
// repo's convention at seven existing call sites. `false` selects the DESKTOP branch, where the
// host's menu is an anchored Popover rather than a bottom sheet.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

function propsFor(overrides: Partial<LeaveControlProps> = {}): LeaveControlProps {
  return {
    isOwner: false,
    contextNoun: 'case',
    isCase: true,
    onLeave: vi.fn(),
    onEndForEveryone: vi.fn(),
    isEnding: false,
    ...overrides,
  };
}

/** Every accessible name in the tree — the sweep the "absent, not disabled" rule needs. */
function accessibleNamesIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-label]')].map(
    (node) => node.getAttribute('aria-label') ?? ''
  );
}

describe('LeaveControl — the :169 fix, gated on isOwner and nothing else', () => {
  describe('isOwner === false — the non-host call', () => {
    it('renders exactly one control, and it says Leave', () => {
      render(<LeaveControl {...propsFor()} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName('Leave');
    });

    it('⚠⚠ "End" appears NOWHERE in the accessible tree — absent, not disabled', () => {
      const { container } = render(<LeaveControl {...propsFor()} />);

      // 1. Not reachable as a control, under any name containing "end".
      expect(screen.queryByRole('button', { name: /end/i })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: /end/i })).toBeNull();
      // 2. Not present as text either — `hidden` markup or an sr-only string would pass (1).
      expect(container.textContent ?? '').not.toMatch(/end/i);
      // 3. Not present as an accessible name on a non-button node.
      expect(accessibleNamesIn(container).join(' ')).not.toMatch(/end/i);
    });

    it('offers no leaving menu at all — there is nothing to choose between', () => {
      render(<LeaveControl {...propsFor()} />);

      expect(screen.queryByRole('button', { name: /leaving options/i })).toBeNull();
    });

    it('leaves immediately, with no confirmation — leaving is reversible', async () => {
      const user = userEvent.setup();
      const onLeave = vi.fn();
      render(<LeaveControl {...propsFor({ onLeave })} />);

      await user.click(screen.getByRole('button', { name: 'Leave' }));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('has no accessibility violations', async () => {
      const { container } = render(<LeaveControl {...propsFor()} />);

      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe('isOwner === true — the host call', () => {
    it('renders the split control: Leave, plus a chevron that opens the options', () => {
      render(<LeaveControl {...propsFor({ isOwner: true })} />);

      expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Leaving options' })).toBeInTheDocument();
    });

    it('the bar button still just leaves — it does not end the call for everyone', async () => {
      const user = userEvent.setup();
      const onLeave = vi.fn();
      const onEndForEveryone = vi.fn();
      render(<LeaveControl {...propsFor({ isOwner: true, onLeave, onEndForEveryone })} />);

      await user.click(screen.getByRole('button', { name: 'Leave' }));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(onEndForEveryone).not.toHaveBeenCalled();
    });

    it('the menu offers both choices, and they are different acts', async () => {
      const user = userEvent.setup();
      render(<LeaveControl {...propsFor({ isOwner: true })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));

      expect(await screen.findByRole('button', { name: 'Leave the call' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'End the call for everyone' })).toBeInTheDocument();
    });

    it('choosing "Leave the call" from the menu leaves without confirming', async () => {
      const user = userEvent.setup();
      const onLeave = vi.fn();
      render(<LeaveControl {...propsFor({ isOwner: true, onLeave })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'Leave the call' }));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('⚠ choosing "End the call for everyone" ALWAYS confirms first', async () => {
      const user = userEvent.setup();
      const onEndForEveryone = vi.fn();
      render(<LeaveControl {...propsFor({ isOwner: true, onEndForEveryone })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('End the call for everyone?')).toBeInTheDocument();
      // Nothing has happened yet — the dialog is a gate, not an announcement.
      expect(onEndForEveryone).not.toHaveBeenCalled();
    });

    it('⚠⚠ focus lands on CANCEL, not on the destructive confirm', async () => {
      const user = userEvent.setup();
      render(<LeaveControl {...propsFor({ isOwner: true })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
      await screen.findByRole('alertdialog');

      // A destructive default focus plus a stray Enter ends a live call for everybody in it.
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    it('Cancel closes the dialog and ends nothing', async () => {
      const user = userEvent.setup();
      const onEndForEveryone = vi.fn();
      const onLeave = vi.fn();
      render(<LeaveControl {...propsFor({ isOwner: true, onEndForEveryone, onLeave })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(onEndForEveryone).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
    });

    it('Confirm raises onEndForEveryone exactly once', async () => {
      const user = userEvent.setup();
      const onEndForEveryone = vi.fn();
      render(<LeaveControl {...propsFor({ isOwner: true, onEndForEveryone })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
      await user.click(await screen.findByRole('button', { name: 'End for everyone' }));

      expect(onEndForEveryone).toHaveBeenCalledTimes(1);
    });

    it('shows the pending label while the eject runs, and both controls are disabled', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<LeaveControl {...propsFor({ isOwner: true })} />);

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
      await screen.findByRole('alertdialog');
      rerender(<LeaveControl {...propsFor({ isOwner: true, isEnding: true })} />);

      // ⚠ The dialog stays OPEN while the action runs, so the pending label is visible at all.
      expect(await screen.findByRole('button', { name: 'Ending…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    describe('the confirm copy (ruling R7)', () => {
      async function openConfirm(overrides: Partial<LeaveControlProps>): Promise<HTMLElement> {
        const user = userEvent.setup();
        render(<LeaveControl {...propsFor({ isOwner: true, ...overrides })} />);
        await user.click(screen.getByRole('button', { name: 'Leaving options' }));
        await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
        return screen.findByRole('alertdialog');
      }

      it('⚠⚠ does NOT claim the end cannot be undone — a client-side eject revokes no token', async () => {
        const dialog = await openConfirm({});

        expect(dialog.textContent ?? '').not.toMatch(/can'?t be undone/i);
        expect(dialog.textContent ?? '').not.toMatch(/cannot be undone/i);
        // ⚠ Nor the opposite over-share: naming the gap advertises a half-working control.
        expect(dialog.textContent ?? '').not.toMatch(/rejoin/i);
      });

      it('names the context it belongs to, from the shared table', async () => {
        const dialog = await openConfirm({ contextNoun: 'retainer', isCase: false });

        expect(dialog.textContent ?? '').toContain(
          'the recap, notes and files all stay with the retainer'
        );
      });

      it('⚠ adds the money reassurance ONLY on a case', async () => {
        const dialog = await openConfirm({ contextNoun: 'case', isCase: true });

        expect(dialog.textContent ?? '').toContain("Time already counted isn't affected.");
      });

      it('omits the money reassurance off a case', async () => {
        const dialog = await openConfirm({ contextNoun: 'project', isCase: false });

        expect(dialog.textContent ?? '').not.toMatch(/time already counted/i);
      });
    });

    it('has no accessibility violations, closed or open', async () => {
      const user = userEvent.setup();
      const { container } = render(<LeaveControl {...propsFor({ isOwner: true })} />);

      expect(await axe(container)).toHaveNoViolations();

      await user.click(screen.getByRole('button', { name: 'Leaving options' }));
      await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
      await screen.findByRole('alertdialog');

      expect(await axe(document.body)).toHaveNoViolations();
    });
  });

  it('⚠ never reads a lens, an activeMode or a role — isOwner is the whole gate', () => {
    // Behavioural restatement of the invariant: the ONLY difference between the two renders is
    // the boolean. `meeting-call-no-lens-gate.test.ts` holds the structural half.
    const guest = render(<LeaveControl {...propsFor({ isOwner: false })} />).container.innerHTML;
    const host = render(<LeaveControl {...propsFor({ isOwner: true })} />).container.innerHTML;

    expect(host).not.toBe(guest);
  });
});
