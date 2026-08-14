import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MeetingToolbar, type MeetingToolbarProps } from './meeting-toolbar';

/**
 * BAL-435 — the day-one toolbar, pinned.
 *
 * ⚠⚠ THE THREE RULES THIS FILE EXISTS TO HOLD:
 *
 *   1. **NO CONTROL IS EVER `disabled`.** An unregistered slot renders NOTHING. A greyed-out Chat
 *      icon reads "chat is broken"; an absent one reads "this call doesn't have chat".
 *   2. **RAISE HAND IS CUT WHOLE (ruling R5)** — not a local visual, not disabled, not in the
 *      overflow, not in the icon imports.
 *   3. **FULLSCREEN IS NEVER IN THE TOOLBAR ON ANY BREAKPOINT.** It is a ViewControl, and it is
 *      desktop-only.
 *
 * ⚠ THE LADDER IS A **CSS** BREAKPOINT (`hidden md:flex`), so in jsdom every control is in the
 * DOM regardless of viewport — which is exactly why the counts below are breakpoint-free.
 * Asserting the ladder itself would be asserting Tailwind, which the testing skill calls out as
 * presentational.
 */

// ⚠ jsdom has no `matchMedia`; the repo's convention (7 existing call sites) is to mock the hook.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

/** ⚠ `TooltipProvider` is NOT mounted at the app root — `meeting-frame-impl.tsx` mounts it. */
function renderToolbar(overrides: Partial<MeetingToolbarProps> = {}): HTMLElement {
  const props: MeetingToolbarProps = {
    micOn: true,
    cameraOn: true,
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    isSharingScreen: false,
    canShareScreen: true,
    onToggleScreenShare: vi.fn(),
    showLayoutToggle: true,
    isGallery: false,
    onToggleLayout: vi.fn(),
    onOpenSettings: vi.fn(),
    moreOpen: false,
    onMoreOpenChange: vi.fn(),
    canEndMeeting: false,
    contextNoun: 'case',
    isCase: true,
    onLeave: vi.fn(),
    onEndForEveryone: vi.fn(),
    isEnding: false,
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <MeetingToolbar {...props} />
    </TooltipProvider>
  ).container;
}

/**
 * ⚠ THE ACCESSIBLE NAMES ARE **STABLE NOUNS**, not the changing action wording. A toggle whose
 * NAME changes while `aria-pressed` flips announces "Unmute, toggle button, pressed", which
 * parses as "unmute is on" — the opposite of the truth. The action ("Mute" / "Unmute") lives in
 * the tooltip, which Radix exposes as a DESCRIPTION and which may change freely.
 */
const DAY_ONE_CONTROLS = ['Microphone', 'Camera', 'Share screen', 'More', 'Leave'];

describe('MeetingToolbar — the day-one control set', () => {
  it('renders exactly Mic · Camera · Share screen · More · Leave, and nothing else', () => {
    renderToolbar();

    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
    expect(names).toEqual(DAY_ONE_CONTROLS);
  });

  it('⚠⚠ has NO disabled control anywhere — an unregistered slot renders nothing at all', () => {
    const container = renderToolbar();

    expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
  });

  it('gives every control a non-empty accessible name', () => {
    renderToolbar();

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
      expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()).not.toBe('');
    }
  });

  describe('⚠ ruling R5 — raise hand is cut WHOLE to BAL-437', () => {
    it('is absent from the bar, closed', () => {
      const container = renderToolbar();

      expect(screen.queryByRole('button', { name: /raise|hand/i })).toBeNull();
      expect(container.textContent ?? '').not.toMatch(/raise|hand/i);
    });

    it('is absent from the overflow menu, open', async () => {
      renderToolbar({ moreOpen: true });

      expect(await screen.findByRole('button', { name: 'Camera and sound' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /raise|hand/i })).toBeNull();
    });
  });

  it('⚠ never puts fullscreen in the toolbar — it is a ViewControl, and desktop-only', () => {
    const container = renderToolbar();

    expect(screen.queryByRole('button', { name: /fullscreen/i })).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/fullscreen/i);
  });

  describe('the mic and camera toggles', () => {
    it('carry aria-pressed, and it tracks the DEVICE state', () => {
      renderToolbar({ micOn: true, cameraOn: true });

      // ⚠ PRESSED = THE DEVICE IS ON. With a stable name ("Microphone") that is the only reading
      // available, which is the whole reason the name no longer changes.
      expect(screen.getByRole('button', { name: 'Microphone' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('⚠⚠ flips aria-pressed while the accessible NAME stays put', () => {
      renderToolbar({ micOn: false, cameraOn: false });

      // ⚠ THE RULE THIS PINS: with `aria-pressed`, the accessible name must be stable. "Unmute,
      // toggle button, pressed" parses as "unmute is on" and means the opposite of the truth.
      expect(screen.getByRole('button', { name: 'Microphone' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      expect(screen.queryByRole('button', { name: 'Unmute' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start video' })).toBeNull();
    });

    it('raises the toggle handlers on click', async () => {
      const user = userEvent.setup();
      const onToggleMic = vi.fn();
      const onToggleCamera = vi.fn();
      renderToolbar({ onToggleMic, onToggleCamera });

      await user.click(screen.getByRole('button', { name: 'Microphone' }));
      await user.click(screen.getByRole('button', { name: 'Camera' }));

      expect(onToggleMic).toHaveBeenCalledTimes(1);
      expect(onToggleCamera).toHaveBeenCalledTimes(1);
    });
  });

  it('the share control is a toggle too, with a stable name', () => {
    renderToolbar({ isSharingScreen: true });

    expect(screen.getByRole('button', { name: 'Share screen' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('⚠⚠ the share control is ABSENT where the browser cannot share — capability, not breakpoint', () => {
    // `getDisplayMedia` does not exist on iOS Safari or Android Chrome. A live-looking control
    // that silently does nothing is worse than the greyed-out one the slot rule forbids.
    const container = renderToolbar({ canShareScreen: false });

    expect(screen.queryByRole('button', { name: 'Share screen' })).toBeNull();
    expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  describe('⚠⚠ the end branch resolves on canEndMeeting and nothing else (BAL-134)', () => {
    it('gives a viewer without end authority no leaving menu', () => {
      const container = renderToolbar({ canEndMeeting: false });

      expect(screen.queryByRole('button', { name: 'Leaving options' })).toBeNull();
      expect(container.textContent ?? '').not.toMatch(/end/i);
    });

    it('gives an end-authority holder the split control', () => {
      renderToolbar({ canEndMeeting: true });

      expect(screen.getByRole('button', { name: 'Leaving options' })).toBeInTheDocument();
    });
  });

  /**
   * BAL-436 — ⚠⚠ THE SIDE-PANEL SLOT. Registered means REAL; unregistered means ABSENT. There
   * is no third state, and in particular there is no disabled one.
   */
  describe('the People and Files slot (BAL-436)', () => {
    it('⚠ renders NEITHER control when the slot is unregistered', () => {
      const container = renderToolbar();

      expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
      expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
    });

    it('renders both when it is registered', () => {
      renderToolbar({ openPanel: null, onTogglePanel: vi.fn() });

      expect(screen.getByRole('button', { name: 'People' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    });

    /**
     * ⚠⚠ THE BREAKPOINT IS `lg`, AND THREE READERS HAVE TO AGREE ON IT.
     *
     * The panel overlays below `lg` (`meeting-side-panel.tsx`). While these buttons were
     * `hidden md:flex` and the MoreSheet rows were `md:hidden`, the 768–1023px band showed the
     * DESKTOP buttons, hid the sheet rows, and opened a full-width overlay — the one width
     * where every reader disagreed. Asserting the class is blunt, and blunt is the point: a
     * CSS-only split cannot be observed any other way in jsdom.
     */
    it.each(['People', 'Files'])(
      '⚠⚠ hides the desktop %s button below `lg`, matching the panel and the sheet',
      (label) => {
        renderToolbar({ openPanel: null, onTogglePanel: vi.fn() });

        const button = screen.getByRole('button', { name: label });
        // ⚠ TOKEN-WISE, not a substring of the whole attribute: `cn` is tailwind-merge, which
        // reorders and drops conflicting classes (the base `flex` loses to `hidden`).
        expect([...button.classList]).toContain('hidden');
        expect([...button.classList]).toContain('lg:flex');
        expect([...button.classList]).not.toContain('md:flex');
      }
    );

    it('⚠ THE NAME STAYS STABLE while `aria-pressed` carries the state', () => {
      // A name that changed beside a flipping `aria-pressed` announces "Hide people, pressed",
      // which parses as the opposite of the truth.
      renderToolbar({ openPanel: 'people', onTogglePanel: vi.fn() });

      const people = screen.getByRole('button', { name: 'People' });
      expect(people).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });

    it.each([
      ['People', 'people'],
      ['Files', 'files'],
    ])('asks the frame to toggle %s', async (label, id) => {
      const user = userEvent.setup();
      const onTogglePanel = vi.fn();
      renderToolbar({ openPanel: null, onTogglePanel });

      await user.click(screen.getByRole('button', { name: label }));

      expect(onTogglePanel).toHaveBeenCalledWith(id);
    });

    it('⚠ the MoreSheet rows appear only when the slot is registered', async () => {
      const user = userEvent.setup();
      const onTogglePanel = vi.fn();
      const { rerender } = render(
        <TooltipProvider>
          <MeetingToolbar
            micOn
            cameraOn
            onToggleMic={vi.fn()}
            onToggleCamera={vi.fn()}
            isSharingScreen={false}
            canShareScreen
            onToggleScreenShare={vi.fn()}
            showLayoutToggle
            isGallery={false}
            onToggleLayout={vi.fn()}
            onOpenSettings={vi.fn()}
            moreOpen
            onMoreOpenChange={vi.fn()}
            canEndMeeting={false}
            contextNoun="case"
            isCase
            onLeave={vi.fn()}
            onEndForEveryone={vi.fn()}
            isEnding={false}
          />
        </TooltipProvider>
      );

      // Unregistered: the overflow holds no People or Files row.
      expect(screen.queryByRole('button', { name: 'People' })).toBeNull();

      rerender(
        <TooltipProvider>
          <MeetingToolbar
            micOn
            cameraOn
            onToggleMic={vi.fn()}
            onToggleCamera={vi.fn()}
            isSharingScreen={false}
            canShareScreen
            onToggleScreenShare={vi.fn()}
            showLayoutToggle
            isGallery={false}
            onToggleLayout={vi.fn()}
            onOpenSettings={vi.fn()}
            moreOpen
            onMoreOpenChange={vi.fn()}
            openPanel={null}
            onTogglePanel={onTogglePanel}
            canEndMeeting={false}
            contextNoun="case"
            isCase
            onLeave={vi.fn()}
            onEndForEveryone={vi.fn()}
            isEnding={false}
          />
        </TooltipProvider>
      );

      // Registered: the bar twin plus the overflow row. Both name the same slot, and the split
      // is CSS — so in jsdom both are in the DOM.
      const peopleControls = screen.getAllByRole('button', { name: 'People' });
      expect(peopleControls.length).toBeGreaterThan(1);
      await user.click(peopleControls[peopleControls.length - 1] as HTMLElement);
      expect(onTogglePanel).toHaveBeenCalledWith('people');
    });
  });

  it('has no accessibility violations', async () => {
    const container = renderToolbar();

    expect(await axe(container)).toHaveNoViolations();
  });
});
