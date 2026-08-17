import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MeetingFrameElementProvider } from './meeting-frame-element';
import { MeetingRouteContextProvider } from '@/lib/meetings/meeting-route-context';
import { MoreSheet, SCREENSHARE_UNSUPPORTED_LINE, type MoreSheetProps } from './more-sheet';

/**
 * BAL-435 — the toolbar's overflow, and ⚠⚠ **THE §8.3 PORTAL RULE.**
 *
 * ── ⚠⚠ WHY THE PORTAL CONTAINER IS A CORRECTNESS BUG, NOT A COSMETIC ONE ────────────────────
 *
 * Radix portals to `document.body` by default, and that fails twice on this surface:
 *
 *   1. Portal content escapes the frame's `.dark` subtree and renders LIGHT chrome over a dark
 *      call.
 *   2. ⚠⚠ **IN FULLSCREEN IT IS INVISIBLE.** When the frame is the fullscreen element the browser
 *      renders ONLY that element's subtree — so a menu portaled to `<body>` simply does not
 *      appear. On the sibling `MeetingConfirmDialog` that is a DESTRUCTIVE-CONFIRM DIALOG
 *      VANISHING while the act it guards stays one keystroke away.
 *
 * The assertion is therefore a DOM ancestry check, not a class check: `className="dark"` on the
 * portal would fix (1) and leave (2) broken.
 */

// jsdom has no `matchMedia`; the repo's convention (7 existing call sites) is to mock the hook.
// `false` selects the DESKTOP branch — an anchored Popover rather than a bottom sheet.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

/** A stand-in for the call frame: a real element, attached, exactly as the frame's ref is. */
let frameElement: HTMLElement;

beforeEach(() => {
  frameElement = document.createElement('div');
  frameElement.setAttribute('data-testid', 'meeting-frame');
  document.body.append(frameElement);
});

afterEach(() => {
  frameElement.remove();
});

function renderMoreSheet(overrides: Partial<MoreSheetProps> = {}): HTMLElement {
  const props: MoreSheetProps = {
    open: false,
    onOpenChange: vi.fn(),
    showLayoutToggle: true,
    isGallery: false,
    onToggleLayout: vi.fn(),
    isSharingScreen: false,
    canShareScreen: true,
    onToggleScreenShare: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  return render(
    <MeetingFrameElementProvider element={frameElement}>
      <TooltipProvider>
        <MoreSheet {...props} />
      </TooltipProvider>
    </MeetingFrameElementProvider>
  ).container;
}

describe('MoreSheet — ⚠⚠ the portal renders INSIDE the frame', () => {
  it('puts the open menu in the frame element, not in document.body', async () => {
    renderMoreSheet({ open: true });

    const item = await screen.findByRole('button', { name: 'Camera and sound' });
    expect(frameElement.contains(item)).toBe(true);
  });

  it('⚠ and NOT as a direct child of <body> — which is what fullscreen would hide', async () => {
    renderMoreSheet({ open: true });

    const item = await screen.findByRole('button', { name: 'Camera and sound' });
    for (const child of document.body.children) {
      if (child === frameElement) continue;
      expect(child.contains(item)).toBe(false);
    }
  });
});

describe('MoreSheet — the slot rule', () => {
  it('offers only what exists today: the layout toggle, sharing, settings and the back link', async () => {
    renderMoreSheet({ open: true });

    const names = (await screen.findAllByRole('button'))
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
      // ⚠ SORTED: the menu is PORTALED, so document order here reflects where the test attached
      // the frame element rather than the visual order. The SET is the contract; the order is an
      // artefact of the harness and asserting it would pin the wrong thing.
      .sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(['Camera and sound', 'Gallery view', 'More', 'Share screen']);
  });

  it('⚠ ruling R5 — Raise hand is absent WHOLE, not disabled and not hidden', async () => {
    renderMoreSheet({ open: true });

    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(screen.queryByRole('button', { name: /raise|hand/i })).toBeNull();
    expect(frameElement.textContent ?? '').not.toMatch(/raise|hand/i);
  });

  it('⚠ registers NO Files, People or Reactions row — an absent slot, not a dead one', async () => {
    renderMoreSheet({ open: true });

    await screen.findByRole('button', { name: 'Camera and sound' });
    for (const slot of [/chat/i, /files/i, /people/i, /reaction/i]) {
      expect(screen.queryByRole('button', { name: slot })).toBeNull();
    }
  });

  it('has no disabled row anywhere', async () => {
    renderMoreSheet({ open: true });

    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(frameElement.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  it('⚠ drops the layout row entirely while there is no layout to toggle', async () => {
    renderMoreSheet({ open: true, showLayoutToggle: false });

    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(screen.queryByRole('button', { name: /gallery view|speaker view/i })).toBeNull();
  });

  it('⚠⚠ offers an ANONYMOUS GUEST no back link at all — not even the dashboard', async () => {
    renderMoreSheet({ open: true });

    // ⚠ NO ROUTE PROVIDER IS MOUNTED HERE, WHICH **IS** THE GUEST CASE — only the member route
    // mounts one. A guest has no Balo dashboard, so "Back to your dashboard" threw them at a
    // login wall and lost them the meeting. The absence is structural, not a lens check.
    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(frameElement.textContent ?? '').not.toMatch(/dashboard/i);
  });

  it('carries the back link as its last item for a MEMBER, never in the top bar', async () => {
    render(
      <MeetingFrameElementProvider element={frameElement}>
        <TooltipProvider>
          <MeetingRouteContextProvider
            meetingId="m-1"
            viewerName={null}
            title={null}
            backTo={{ label: 'Back to the case', href: '/consultations' }}
            contextNoun="case"
            waiting={null}
          >
            <MoreSheet
              open
              onOpenChange={vi.fn()}
              showLayoutToggle
              isGallery={false}
              onToggleLayout={vi.fn()}
              isSharingScreen={false}
              canShareScreen
              onToggleScreenShare={vi.fn()}
              onOpenSettings={vi.fn()}
            />
          </MeetingRouteContextProvider>
        </TooltipProvider>
      </MeetingFrameElementProvider>
    );

    expect(await screen.findByRole('link', { name: 'Back to the case' })).toHaveAttribute(
      'href',
      '/consultations'
    );
  });

  it('⚠⚠ says so rather than failing silently where the browser cannot share a screen', async () => {
    // `getDisplayMedia` is absent on iOS Safari and Android Chrome. The row used to render live
    // and produce no picker, no state change and no message.
    renderMoreSheet({ open: true, canShareScreen: false });

    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(screen.queryByRole('button', { name: /share screen/i })).toBeNull();
    expect(screen.getByText(SCREENSHARE_UNSUPPORTED_LINE)).toBeInTheDocument();
  });
});

describe('MoreSheet — behaviour', () => {
  it('closes itself before running the chosen action', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onOpenSettings = vi.fn();
    renderMoreSheet({ open: true, onOpenChange, onOpenSettings });

    await user.click(await screen.findByRole('button', { name: 'Camera and sound' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('the trigger reports its own state, so a screen reader knows the menu is open', () => {
    renderMoreSheet({ open: true });

    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders nothing but the trigger while closed', () => {
    renderMoreSheet({ open: false });

    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Camera and sound' })).toBeNull();
  });

  /**
   * BAL-436 — ⚠⚠ THE SLOT RULE, ON THE OVERFLOW. `onTogglePanel === undefined` means the two
   * rows render NOTHING. Both GUEST mounts land there structurally.
   */
  describe('the People and Files rows (BAL-436)', () => {
    it('⚠ renders NEITHER row when the slot is unregistered', async () => {
      renderMoreSheet({ open: true });

      await screen.findByRole('button', { name: 'Camera and sound' });
      expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
    });

    it('renders both when it is registered', async () => {
      renderMoreSheet({ open: true, onTogglePanel: vi.fn() });

      expect(await screen.findByRole('button', { name: 'People' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    });

    it.each([
      ['People', 'people'],
      ['Files', 'files'],
    ])('closes the sheet and toggles %s', async (label, id) => {
      const user = userEvent.setup();
      const onTogglePanel = vi.fn();
      const onOpenChange = vi.fn();
      renderMoreSheet({ open: true, onTogglePanel, onOpenChange });

      await user.click(await screen.findByRole('button', { name: label }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onTogglePanel).toHaveBeenCalledWith(id);
    });
  });

  /**
   * BAL-437 — ⚠⚠ **THERE IS NO `Chat` ROW HERE, AND THAT IS DELIBERATE.**
   *
   * Chat's bar twin is the mobile ladder's slot 3, and unlike People / Files / Share screen
   * that button carries NO breakpoint class — it is visible from 320px up. A row here would be
   * a SECOND live control for the same slot at every width, doubling the tab order and what a
   * screen-reader user hears. The Reactions row exists precisely because ITS bar twin IS hidden
   * below `md`, exactly like Share screen's.
   */
  describe('Chat and Reactions (BAL-437)', () => {
    it('⚠⚠ renders NO Chat row even when the panel slot IS registered — and takes no `hasChat`', async () => {
      renderMoreSheet({ open: true, onTogglePanel: vi.fn() });

      await screen.findByRole('button', { name: 'People' });
      expect(screen.queryByRole('button', { name: /^chat$/i })).toBeNull();
    });

    it('⚠ renders NO Reactions row when realtime is unregistered', async () => {
      renderMoreSheet({ open: true, onTogglePanel: vi.fn() });

      await screen.findByRole('button', { name: 'People' });
      expect(screen.queryByRole('button', { name: 'React' })).toBeNull();
      expect(frameElement.querySelectorAll('[disabled]')).toHaveLength(0);
    });

    it('renders the React row when realtime IS registered', async () => {
      renderMoreSheet({ open: true, onOpenReactions: vi.fn() });

      expect(await screen.findByRole('button', { name: 'React' })).toBeInTheDocument();
    });

    it('closes the sheet and opens the picker', async () => {
      const user = userEvent.setup();
      const onOpenReactions = vi.fn();
      const onOpenChange = vi.fn();
      renderMoreSheet({ open: true, onOpenReactions, onOpenChange });

      await user.click(await screen.findByRole('button', { name: 'React' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenReactions).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * BAL-403 — the Balance row, `lg:hidden`. Rendered only when `hasBalance` — never a disabled
   * row for a registered-but-absent slot, matching the toolbar's own rule.
   */
  describe('the Balance row (BAL-403)', () => {
    it('⚠ renders NO row when the slot is unregistered', async () => {
      renderMoreSheet({ open: true, onTogglePanel: vi.fn() });

      await screen.findByRole('button', { name: 'People' });
      expect(screen.queryByRole('button', { name: /balance/i })).toBeNull();
    });

    it('⚠ renders NO row when `onTogglePanel` itself is unregistered, even with hasBalance', async () => {
      renderMoreSheet({ open: true, hasBalance: true });

      await screen.findByRole('button', { name: 'Camera and sound' });
      expect(screen.queryByRole('button', { name: /balance/i })).toBeNull();
    });

    it('renders the row when registered', async () => {
      renderMoreSheet({ open: true, onTogglePanel: vi.fn(), hasBalance: true });

      expect(await screen.findByRole('button', { name: 'Balance' })).toBeInTheDocument();
    });

    it('closes the sheet and toggles balance', async () => {
      const user = userEvent.setup();
      const onTogglePanel = vi.fn();
      const onOpenChange = vi.fn();
      renderMoreSheet({ open: true, onTogglePanel, onOpenChange, hasBalance: true });

      await user.click(await screen.findByRole('button', { name: 'Balance' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onTogglePanel).toHaveBeenCalledWith('balance');
    });

    it('⚠⚠ OQ2 — carries the SAME attention flag as the toolbar button, in its accessible name and a dot', async () => {
      renderMoreSheet({
        open: true,
        onTogglePanel: vi.fn(),
        hasBalance: true,
        balanceAttention: true,
      });

      expect(
        await screen.findByRole('button', { name: 'Balance, needs attention' })
      ).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-attention-dot')).toBeInTheDocument();
    });
  });

  it('has no accessibility violations, open', async () => {
    renderMoreSheet({ open: true });

    await screen.findByRole('button', { name: 'Camera and sound' });
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
