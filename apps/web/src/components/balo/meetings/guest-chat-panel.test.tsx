import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type {
  MeetingGuestChatPanelActions,
  MeetingGuestFilePanelActions,
} from '@/lib/meetings/meeting-panels';
import { GuestChatPanel } from './guest-chat-panel';

/**
 * BAL-445 — the GUEST Chat panel. R9's "absence beats disablement", made executable: no
 * composer, no textarea, no "send" button anywhere — and no `viewerUserId`, so every bubble
 * renders as somebody else's.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: 'msg-1',
    conversationId: 'c1',
    bodyHtml: '<p>Hello from the call</p>',
    senderUserId: 'u-someone',
    senderName: 'Dana',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function chatActions(
  overrides: Partial<MeetingGuestChatPanelActions> = {}
): MeetingGuestChatPanelActions {
  return {
    fetchThread: vi.fn().mockResolvedValue({ success: true, messages: [], hasEarlier: false }),
    ...overrides,
  };
}

function filesActions(
  overrides: Partial<MeetingGuestFilePanelActions> = {}
): MeetingGuestFilePanelActions {
  return {
    list: vi.fn().mockResolvedValue({ success: true, files: [] }),
    download: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com/f' }),
    ...overrides,
  };
}

describe('GuestChatPanel', () => {
  it('renders the transcript once loaded, with every bubble as "somebody else\'s"', async () => {
    const chat = chatActions({
      fetchThread: vi.fn().mockResolvedValue({
        success: true,
        messages: [message()],
        hasEarlier: false,
      }),
    });
    render(
      <GuestChatPanel chat={chat} files={filesActions()} onClose={vi.fn()} onOpenFiles={vi.fn()} />
    );

    expect(await screen.findByText('Hello from the call')).toBeInTheDocument();
    // ⚠ No `viewerUserId` ⇒ `isOwn` is always false ⇒ never rendered as "You".
    expect(screen.queryByText('You')).toBeNull();
  });

  it('shows the freshness line, not a live-transport status', async () => {
    render(
      <GuestChatPanel
        chat={chatActions()}
        files={filesActions()}
        onClose={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    );

    expect(
      await screen.findByText(/conversation as of when you opened this panel/i)
    ).toBeInTheDocument();
  });

  it('shows absence-framed empty copy', async () => {
    render(
      <GuestChatPanel
        chat={chatActions()}
        files={filesActions()}
        onClose={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    );

    expect(
      await screen.findByText('Nothing has been said in this conversation.')
    ).toBeInTheDocument();
  });

  it('shows a retry-able error card on a failed load', async () => {
    const chat = chatActions({
      fetchThread: vi.fn().mockResolvedValue({ success: false, error: 'x' }),
    });
    render(
      <GuestChatPanel chat={chat} files={filesActions()} onClose={vi.fn()} onOpenFiles={vi.fn()} />
    );

    expect(await screen.findByText("We couldn't load the conversation")).toBeInTheDocument();
  });

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — a genuine REJECTION (not a handled `{ success: false }`)
   * used to have no `.catch` anywhere on this path, leaving the panel on a PERMANENT skeleton.
   */
  it('⚠ a REJECTED fetchThread() (not a handled failure) still resolves to the error card, never a permanent skeleton', async () => {
    const chat = chatActions({
      fetchThread: vi.fn().mockRejectedValue(new Error('network blew up')),
    });
    render(
      <GuestChatPanel chat={chat} files={filesActions()} onClose={vi.fn()} onOpenFiles={vi.fn()} />
    );

    expect(await screen.findByText("We couldn't load the conversation")).toBeInTheDocument();
  });

  /**
   * ⚠⚠ CRITICAL-5 / F6 (fix-round-1) — G-NEW-3's chat half was VACUOUS: the plan named five
   * assertions and this test implemented two (`textarea`, `/send/i`). Proven by mutation:
   * pasting `chat-composer.tsx`'s paperclip pair (`<input type="file">` + a "Share a file with
   * the call" button) into `GuestChatPanel`'s footer left all six tests in this file GREEN. The
   * three assertions below are what would have caught it.
   */
  it('⚠⚠ ABSENCE, NOT DISABLEMENT — no composer, no upload affordance anywhere', async () => {
    const chat = chatActions({
      fetchThread: vi.fn().mockResolvedValue({
        success: true,
        messages: [message()],
        hasEarlier: false,
      }),
    });
    const { container } = render(
      <GuestChatPanel chat={chat} files={filesActions()} onClose={vi.fn()} onOpenFiles={vi.fn()} />
    );
    await screen.findByText('Hello from the call');

    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /send/i })).toHaveLength(0);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/share a file/i)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /share/i })).toHaveLength(0);
  });

  it('has no accessibility violations', async () => {
    const chat = chatActions({
      fetchThread: vi.fn().mockResolvedValue({
        success: true,
        messages: [message()],
        hasEarlier: false,
      }),
    });
    const { container } = render(
      <GuestChatPanel chat={chat} files={filesActions()} onClose={vi.fn()} onOpenFiles={vi.fn()} />
    );
    await screen.findByText('Hello from the call');
    expect(await axe(container)).toHaveNoViolations();
  });
});
