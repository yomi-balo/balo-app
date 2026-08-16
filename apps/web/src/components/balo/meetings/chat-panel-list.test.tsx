import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import { ChatPanelList, type ChatTimelineItem } from './chat-panel-list';

/**
 * BAL-437 — the in-call chat TIMELINE, tested at its own level.
 *
 * ── ⚠⚠ WHY A SEPARATE FILE FROM `chat-panel.test.tsx` ───────────────────────────────────
 *
 * The two properties below are about SCROLL and about a LIVE REGION, and neither is observable
 * through `ChatPanel`: the scroll box belongs to `MeetingSidePanel` and its `overflow-y-auto`
 * comes from a Tailwind class, which jsdom never resolves into computed style. Driving this
 * component directly lets the test supply a real scroll parent (an INLINE `overflow-y`, which
 * jsdom does resolve) and assert the behaviour rather than the class name.
 *
 * ── ⚠⚠ THE DEFECT THESE PIN ─────────────────────────────────────────────────────────────
 *
 * The stick-to-bottom effect keyed on `items.length` GROWING. `loadEarlier` PREPENDS an older
 * page, which also grows the array — so pressing "Show earlier messages" scrolled the person
 * straight back to the newest message. The one control whose entire purpose is to move them
 * away from the bottom put them back at it, every time.
 */

const VIEWER_ID = '11111111-2222-4333-8444-555555555555';

function message(id: string, at: string): ConversationMessageView {
  return {
    id,
    conversationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    bodyHtml: `<p>${id}</p>`,
    senderUserId: '22222222-3333-4444-8555-666666666666',
    senderName: 'Priya Raman',
    createdAtIso: at,
  };
}

function items(...ids: readonly string[]): ChatTimelineItem[] {
  return ids.map((id, index) => ({
    kind: 'message',
    at: `2026-08-14T09:0${index}:00.000Z`,
    message: message(id, `2026-08-14T09:0${index}:00.000Z`),
  }));
}

/**
 * The list inside a real scrollable ancestor.
 *
 * ⚠ AN **INLINE** `overflow-y`, because jsdom resolves inline styles into `getComputedStyle`
 * but resolves no stylesheet — which is exactly how `scrollParentOf` is written to be findable
 * without knowing a Tailwind class name.
 *
 * ⚠ ONE BUILDER FOR BOTH `render` AND `rerender`. Two near-identical trees is the shape the
 * duplication gate exists to catch, and it is also how the two drift apart mid-test.
 */
function panel(
  list: readonly ChatTimelineItem[],
  overrides: { isLoadingEarlier?: boolean } = {}
): React.ReactElement {
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <ChatPanelList
        items={list}
        viewerUserId={VIEWER_ID}
        hasEarlier
        isLoadingEarlier={overrides.isLoadingEarlier ?? false}
        earlierFailed={false}
        onLoadEarlier={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    </div>
  );
}

function renderList(list: readonly ChatTimelineItem[]) {
  return render(panel(list));
}

function rerenderList(
  rerender: (ui: React.ReactElement) => void,
  list: readonly ChatTimelineItem[],
  overrides: { isLoadingEarlier?: boolean } = {}
): void {
  rerender(panel(list, overrides));
}

const scrollIntoView = vi.fn();

/**
 * The timeline's staged height, in px.
 *
 * ⚠⚠ IT IS READ THROUGH A **PROTOTYPE GETTER INSTALLED IN `beforeEach`**, not through an
 * `Object.defineProperty` on the scroller after `render`. The capture happens in a layout effect
 * on the FIRST commit, which is over before a test can reach the node — so a getter defined
 * afterwards is invisible to it and the first measurement is jsdom's `0`. That is precisely how
 * the earlier version of the prepend test measured a 1400px delta where 400 was staged.
 */
let timelineHeight = 0;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements no layout and no `scrollIntoView`.
  Element.prototype.scrollIntoView = scrollIntoView;
  timelineHeight = 0;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => timelineHeight,
  });
});

afterEach(() => {
  // ⚠ RESTORED, so a frozen `scrollHeight` cannot leak into any later suite in the run.
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
});

describe('ChatPanelList — ⚠⚠ stick to the bottom on an APPEND, never on a PREPEND', () => {
  it('scrolls to the bottom when a NEW message arrives at the end', () => {
    const { rerender } = renderList(items('a', 'b'));
    scrollIntoView.mockClear();

    rerenderList(rerender, items('a', 'b', 'c'));

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('⚠⚠ does NOT scroll when an older page is PREPENDED — "Show earlier" must stay usable', () => {
    const { rerender } = renderList(items('b', 'c'));
    scrollIntoView.mockClear();

    // The same last item, two more rows in front of it — exactly what `loadEarlier` produces.
    rerenderList(rerender, [...items('z', 'y'), ...items('b', 'c')]);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('⚠ RESTORES THE READING POSITION on a prepend — the row they were reading does not move', () => {
    // jsdom lays nothing out, so the heights are staged by hand. ⚠ BEFORE THE MOUNT — the first
    // commit's layout effect is what captures the pre-growth height.
    timelineHeight = 1000;
    const { rerender } = renderList(items('b', 'c'));
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 250;

    // The timeline gains 400px of OLDER rows, all of them in front of the row being read.
    timelineHeight = 1400;
    rerenderList(rerender, [...items('z', 'y'), ...items('b', 'c')]);

    // ⚠ THE SAME PIXEL OF CONTENT IS UNDER THEIR EYES: 250 + exactly what was gained above it.
    expect(scroller.scrollTop).toBe(650);
  });

  /**
   * ⚠⚠ THE PRE-GROWTH HEIGHT IS RE-MEASURED ON **EVERY** COMMIT, NOT ONLY ON ITEM-LIST CHANGES.
   *
   * Pressing the control flips `isLoadingEarlier`, which re-labels the button
   * ("Show earlier messages" → the longer "Loading earlier messages…") and can wrap it in a
   * narrow in-call panel — a height change with NO change to `items`. A capture keyed on the item
   * list would still be holding the height from before that swap, and would then restore by the
   * label's growth on top of the page's, shifting the reader's row by exactly the amount this
   * whole mechanism exists to hold still.
   */
  it('⚠ re-measures on a commit that changed HEIGHT but not the items — the label swap', () => {
    timelineHeight = 1000;
    const { rerender } = renderList(items('b', 'c'));
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 250;

    // The "Loading earlier messages…" swap: same two items, 40px taller.
    timelineHeight = 1040;
    rerenderList(rerender, items('b', 'c'), { isLoadingEarlier: true });

    // Then the page lands: 400px of older rows on top of the already-grown panel.
    timelineHeight = 1440;
    rerenderList(rerender, [...items('z', 'y'), ...items('b', 'c')]);

    // ⚠ 650, NOT 690. Only the 400px gained by the PREPEND is restored; the 40px the label cost
    // was already on screen before the page arrived and must not be counted twice.
    expect(scroller.scrollTop).toBe(650);
  });
});

describe('ChatPanelList — ⚠⚠ the live region', () => {
  it('⚠⚠ is a `log`, so a participant WITH THE PANEL OPEN hears an arriving message', () => {
    // Nothing else tells them: `unreadChat` is force-cleared while the panel is open, and the
    // hook's `onMessage` deliberately does not announce through the frame's §16 region.
    renderList(items('a'));

    expect(screen.getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
  });

  it('⚠ announces the SENDER AND THE BODY — both are inside the region', () => {
    renderList(items('a'));

    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('Priya Raman');
    expect(log).toHaveTextContent('a');
  });

  it('⚠ carries NO `aria-atomic` — the default re-reads only the ADDED row, not the thread', () => {
    renderList(items('a', 'b'));

    expect(screen.getByRole('log')).not.toHaveAttribute('aria-atomic');
  });
});

describe('ChatPanelList — the paging control', () => {
  it('⚠ names WHICH read is in flight — "Loading earlier messages…", not "Loading…"', () => {
    render(
      <ChatPanelList
        items={items('a')}
        viewerUserId={VIEWER_ID}
        hasEarlier
        isLoadingEarlier
        earlierFailed={false}
        onLoadEarlier={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /loading earlier messages/i })).toBeInTheDocument();
  });

  it('⚠ a failed page renders an inline line beside the button, not silence', () => {
    render(
      <ChatPanelList
        items={items('a')}
        viewerUserId={VIEWER_ID}
        hasEarlier
        isLoadingEarlier={false}
        earlierFailed
        onLoadEarlier={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    );

    expect(screen.getByText(/couldn't load the earlier messages/i)).toBeInTheDocument();
    // ⚠ THE CONTROL STAYS — the remedy is to press it again.
    expect(screen.getByRole('button', { name: /show earlier messages/i })).toBeInTheDocument();
  });
});
