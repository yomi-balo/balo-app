import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MEETING_REACTIONS, type MeetingReactionEmoji } from '@/lib/meetings/meeting-reactions';
import { MeetingFrameElementProvider } from './meeting-frame-element';
import { ReactionPicker } from './reaction-picker';

/**
 * BAL-437 — the six-emoji picker.
 *
 * ⚠⚠ THE **OPTIMISTIC RENDER** IS THE CLAIM WORTH TESTING, and it is asserted here as "the
 * handler fires BEFORE the promise settles". The float itself lives in `ReactionFloaters`,
 * driven by the frame's hook; what this component owes is that the tap does not wait on the
 * network. R2 makes the reaction ride a Server Action, so if the picker awaited it the emoji
 * would appear a round trip late — the one thing the optimistic design exists to prevent.
 *
 * ── ⚠⚠ **BOTH BREAKPOINT ARMS ARE EXERCISED, AND ONLY ONE USED TO BE** ──────────────────
 *
 * Every test in this file mocked `useIsMobile` to `false`, so the DESKTOP Popover was the only
 * shape ever rendered — and the mobile arm is where the defect was: below 768px `MeetingMenu`
 * becomes a Radix **Dialog** while this component's trigger is `hidden md:flex`, so Radix
 * restored focus to a `display: none` node and dropped it to `<body>`. Zero coverage of the
 * arm that was broken is how that shipped, so the mock is now per-describe.
 */

const { isMobile } = vi.hoisted(() => ({ isMobile: { current: false } }));

// jsdom has no `matchMedia`; the flag selects the arm explicitly per block.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile.current }));

function renderPicker(
  overrides: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onSelect?: (emoji: MeetingReactionEmoji) => void;
    mobileOpenerRef?: React.RefObject<HTMLButtonElement | null>;
  } = {}
): HTMLElement {
  const frameElement = document.createElement('div');
  document.body.append(frameElement);
  return render(
    <MeetingFrameElementProvider element={frameElement}>
      <TooltipProvider>
        {/* ⚠ A STAND-IN FOR THE **More** BUTTON, which really lives in `MoreSheet` — the frame
            owns the ref and hands it to both. Rendering one here is what makes the mobile
            focus-restore assertion possible without mounting the whole toolbar. */}
        <button type="button" ref={overrides.mobileOpenerRef} data-testid="more-button">
          More
        </button>
        <ReactionPicker
          open={overrides.open ?? true}
          onOpenChange={overrides.onOpenChange ?? vi.fn()}
          onSelect={overrides.onSelect ?? vi.fn()}
          mobileOpenerRef={overrides.mobileOpenerRef}
        />
      </TooltipProvider>
    </MeetingFrameElementProvider>
  ).container;
}

/**
 * The mobile arm, wired the way the frame wires it: the frame owns the open state AND the ref to
 * the More button, and hands both down.
 *
 * ⚠⚠ **THE FRAME ELEMENT IS PASSED IN, ALREADY ATTACHED TO THE DOCUMENT — IT USED TO BE CREATED
 * DETACHED IN HERE, AND THAT IS WHY THIS SUITE COULD NOT SEE THE SHEET AT ALL.** `MeetingMenu`
 * portals its Dialog INTO this element (§8.3), so a `document.createElement('div')` that is never
 * appended renders the whole sheet outside the document: `screen.getByLabelText('🎉')` found
 * nothing, and the focus-restore assertion below never got to run. Attaching it is not a
 * convenience — it is the difference between exercising the mobile arm and skipping it.
 */
function MobilePickerHarness({
  frameElement,
}: Readonly<{ frameElement: HTMLElement }>): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <MeetingFrameElementProvider element={frameElement}>
      <TooltipProvider>
        {/* ⚠ THE STAND-IN FOR `MoreSheet`'s TRIGGER — the real mobile entry point to the picker,
            and therefore the only correct place for focus to return to. */}
        <button type="button" ref={moreButtonRef} data-testid="more-button">
          More
        </button>
        <ReactionPicker
          open={open}
          onOpenChange={setOpen}
          onSelect={vi.fn()}
          mobileOpenerRef={moreButtonRef}
        />
      </TooltipProvider>
    </MeetingFrameElementProvider>
  );
}

beforeEach(() => {
  isMobile.current = false;
});

describe('ReactionPicker — the closed set', () => {
  it('⚠⚠ renders EXACTLY six choices, in acceptance-criterion order', () => {
    renderPicker();

    const group = screen.getByRole('group', { name: 'Reactions' });
    const items = [...group.querySelectorAll('button')];
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([...MEETING_REACTIONS]);
  });

  it('⚠⚠ is a `group`, NOT a `menu` — the role must follow the behaviour, never lead it', () => {
    /**
     * ⚠ `role="menu"` / `role="menuitem"` PROMISES the menu keyboard interface: one tab stop,
     * arrow keys, Home/End. This ships six plain tab stops and no arrow handling, so the role
     * told a screen-reader user to press ↓ and nothing happened — worse than no role at all,
     * because the role is what made them try. If somebody adds real roving tabindex later, the
     * role can come back.
     */
    renderPicker();

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('group', { name: 'Reactions' })).toBeInTheDocument();
  });

  it('⚠ offers NO 👎 and NO 😢', () => {
    renderPicker();

    expect(screen.queryByLabelText('👎')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('😢')).not.toBeInTheDocument();
  });

  it('⚠ every target is ≥44px — a one-tap control on a phone mid-call', () => {
    renderPicker();

    for (const emoji of MEETING_REACTIONS) {
      // `h-11 w-11` is 44px in this scale. jsdom computes no layout, so the CLASS is the
      // assertable contract — and it is the one the design system states.
      const item = screen.getByLabelText(emoji);
      expect(item.className).toContain('h-11');
      expect(item.className).toContain('w-11');
    }
  });
});

describe('ReactionPicker — selection', () => {
  it('⚠⚠ fires `onSelect` SYNCHRONOUSLY on tap — the float never waits on the network', async () => {
    const onSelect = vi.fn();
    // A send that never settles. The handler must still have fired.
    renderPicker({ onSelect });

    await userEvent.click(screen.getByLabelText('🎉'));

    expect(onSelect).toHaveBeenCalledWith('🎉');
  });

  it('⚠ CLOSES ON SELECTION — prototype behaviour, and one tap ⇒ one invocation', async () => {
    const onOpenChange = vi.fn();
    renderPicker({ onOpenChange });

    await userEvent.click(screen.getByLabelText('👍'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes BEFORE it sends, so the emoji is visible on the stage rather than behind the popover', async () => {
    const order: string[] = [];
    renderPicker({
      onOpenChange: () => order.push('close'),
      onSelect: () => order.push('select'),
    });

    await userEvent.click(screen.getByLabelText('❤️'));

    expect(order).toEqual(['close', 'select']);
  });
});

describe('ReactionPicker — the trigger and dismissal', () => {
  it('the trigger is a named, non-destructive toolbar control', () => {
    renderPicker({ open: false });

    const trigger = screen.getByRole('button', { name: 'React' });
    expect(trigger).toBeInTheDocument();
    // ⚠ NEVER `disabled`: an unregistered slot renders NOTHING, and a registered one works.
    expect(trigger).not.toBeDisabled();
  });

  it('⚠ Escape closes — Radix owns it, and this asserts it is actually wired', async () => {
    const onOpenChange = vi.fn();
    renderPicker({ onOpenChange });

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ReactionPicker — ⚠⚠ FOCUS RESTORE BELOW 768px (the arm nothing used to cover)', () => {
  beforeEach(() => {
    // ⚠⚠ THE MOBILE ARM. `MeetingMenu` renders a Radix **Dialog** here, and this component's own
    // trigger is `hidden md:flex` — the exact composition that dropped focus to `<body>`.
    isMobile.current = true;
  });

  it('⚠⚠ FOCUS LANDS ON THE **More** BUTTON, not on `<body>`, when the sheet closes', async () => {
    /**
     * ⚠ DRIVEN THROUGH RADIX RATHER THAN BY CALLING THE HANDLER DIRECTLY: the property under
     * test is that `onCloseAutoFocus` is actually WIRED into `MeetingMenu`'s Dialog arm. Calling
     * the callback by hand would pass even if the prop were dropped on the floor.
     *
     * ⚠ THE PICKER IS CONTROLLED BY THE FRAME, so the harness holds the open state exactly as
     * `useCallRealtimeSlot` does — a selection closes it, which is what triggers the restore.
     */
    // ⚠ ATTACHED BEFORE THE RENDER. Radix portals the sheet INTO this node; a detached one puts
    // the entire mobile arm outside the document — see the harness docblock.
    const frameElement = document.createElement('div');
    document.body.append(frameElement);

    render(<MobilePickerHarness frameElement={frameElement} />);
    await userEvent.click(screen.getByLabelText('🎉'));

    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('more-button')));
  });

  it('⚠ with NO opener ref it leaves Radix alone — swallowing the event with no target is worse', async () => {
    // Guarding this way is what keeps the handler safe for any caller that renders the picker
    // above the breakpoint only.
    const onOpenChange = vi.fn();
    renderPicker({ onOpenChange });

    await userEvent.click(screen.getByLabelText('👏'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders the same six choices as a bottom sheet', () => {
    renderPicker();

    const group = screen.getByRole('group', { name: 'Reactions' });
    expect([...group.querySelectorAll('button')]).toHaveLength(6);
  });
});

describe('ReactionPicker — accessibility', () => {
  it('has no violations when open (desktop popover)', async () => {
    const container = renderPicker();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations when open (mobile sheet)', async () => {
    isMobile.current = true;
    const container = renderPicker();

    expect(await axe(container)).toHaveNoViolations();
  });
});
