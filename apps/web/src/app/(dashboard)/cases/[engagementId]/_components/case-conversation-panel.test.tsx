import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import type { CaseConversationView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — the case's conversation region, with the CLOSED-case read-only contract as the
 * centrepiece.
 *
 * ⚠⚠ A CLOSED CASE IS READ-ONLY BUT FULLY READABLE, AND THOSE ARE TWO SEPARATE ASSERTIONS.
 * `writable` is composed ONCE at the gate from `engagementConversationIsWritable(status)`, and
 * `postCaseMessageAction` re-checks it server-side — so a component that merely HID the
 * composer while leaving history unreachable, or that left the composer mounted, would each be
 * a different failure. Both are tested below.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000002';
const VIEWER_ID = 'u0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => (
      <div className={props.className as string}>{props.children as React.ReactNode}</div>
    ),
  },
  useReducedMotion: () => true,
  AnimatePresence: (props: Record<string, unknown>) => <>{props.children as React.ReactNode}</>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// The realtime hook opens an Ably channel; nothing here is about transport.
const mockUseRealtime = vi.fn();
vi.mock('@/components/balo/conversation/use-conversation-realtime', () => ({
  useConversationRealtime: (...a: unknown[]) => mockUseRealtime(...a),
}));

const mockMarkRead = vi.fn();
vi.mock('../_actions/create-case-realtime-token', () => ({
  createCaseRealtimeTokenAction: vi.fn(),
}));
vi.mock('../_actions/fetch-case-thread', () => ({ fetchCaseThreadAction: vi.fn() }));
vi.mock('../_actions/post-case-message', () => ({ postCaseMessageAction: vi.fn() }));
vi.mock('../_actions/mark-case-thread-read', () => ({
  markCaseThreadReadAction: (...a: unknown[]) => mockMarkRead(...a),
}));
vi.mock('../_actions/request-case-file-upload', () => ({ requestCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/confirm-case-file-upload', () => ({ confirmCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/get-case-file-download', () => ({ getCaseFileDownloadAction: vi.fn() }));

import { CaseConversationPanel } from './case-conversation-panel';

function conversation(over: Partial<CaseConversationView> = {}): CaseConversationView {
  return {
    conversationId: CONVERSATION_ID,
    writable: true,
    counterpartyFirstName: 'Amara',
    counterpartyName: 'Amara Okafor',
    initialMessages: [
      {
        id: 'msg-1',
        conversationId: CONVERSATION_ID,
        bodyHtml: '<p>Here is the flow you asked about.</p>',
        senderUserId: 'u-other',
        senderName: 'Amara',
        createdAtIso: '2026-07-01T10:00:00Z',
      },
    ],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
    ...over,
  };
}

function renderPanel(
  over: Partial<CaseConversationView> = {},
  lens: 'client' | 'expert' = 'client'
) {
  return render(
    <CaseConversationPanel
      engagementId={ENGAGEMENT_ID}
      conversation={conversation(over)}
      lens={lens}
      viewerUserId={VIEWER_ID}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkRead.mockResolvedValue({ success: true });
});

describe('CaseConversationPanel — a CLOSED case is read-only but fully readable', () => {
  it('removes the composer entirely and says why', () => {
    renderPanel({ writable: false });
    expect(
      screen.getByText('This case is closed, so the conversation is read-only.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('STILL RENDERS THE HISTORY — read access and write access are separate questions', () => {
    renderPanel({ writable: false });
    expect(screen.getByText('Here is the flow you asked about.')).toBeInTheDocument();
  });

  it('offers no attach affordance on a closed case', () => {
    renderPanel({ writable: false });
    expect(screen.queryByRole('button', { name: /attach/i })).not.toBeInTheDocument();
  });

  it('drops the free-messages footnote — it invites an action the surface just refused', () => {
    renderPanel({ writable: false });
    expect(screen.queryByText(/Messages are free/i)).not.toBeInTheDocument();
  });

  it('renders the composer and the lens-appropriate footnote while OPEN', () => {
    const { unmount } = renderPanel({ writable: true }, 'client');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(
      screen.getByText('Messages are free. Book a consultation when you need time on a call.')
    ).toBeInTheDocument();
    unmount();

    renderPanel({ writable: true }, 'expert');
    expect(
      screen.getByText('Messages are free and unbilled — only consultations are.')
    ).toBeInTheDocument();
  });
});

describe('CaseConversationPanel — the read watermark', () => {
  it('marks the thread read ONCE on mount — opening the case IS reading its thread', async () => {
    renderPanel();
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID });
    });
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });

  it('swallows a watermark failure — it must never surface on a page just opened', async () => {
    mockMarkRead.mockRejectedValue(new Error('offline'));
    renderPanel();
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalled();
    });
    expect(screen.getByText('Here is the flow you asked about.')).toBeInTheDocument();
  });

  it('marks read on a CLOSED case too — a closed thread is still being read', async () => {
    renderPanel({ writable: false });
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * ⚠⚠ THE ARRAY IDENTITY IS LOAD-BEARING. `conversationIds` is an effect dependency inside
 * `useConversationRealtime`, so a fresh literal on every render would tear down and
 * re-subscribe the Ably channel continuously — presenting as flapping connectivity rather than
 * as a bug. It is `useMemo`d (NOT a ref mutated during render, which React forbids and which
 * misbehaves under StrictMode's double render).
 */
describe('CaseConversationPanel — a stable conversationIds identity across re-renders', () => {
  it('hands the hook the SAME array instance when nothing changed', () => {
    const view = conversation();
    const { rerender } = render(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={view}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const first = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    rerender(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={{ ...view }}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const second = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    expect(second.conversationIds).toEqual([CONVERSATION_ID]);
    // Identity, not equality — an `toEqual` here would pass on a fresh literal every render.
    expect(second.conversationIds).toBe(first.conversationIds);
  });

  it('produces a NEW array when the conversation id genuinely changes', () => {
    const { rerender } = renderPanel();
    const first = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    rerender(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={conversation({ conversationId: 'other-conversation' })}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const second = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    expect(second.conversationIds).toEqual(['other-conversation']);
    expect(second.conversationIds).not.toBe(first.conversationIds);
  });

  it('passes the gate-composed realtimeEnabled straight through', () => {
    renderPanel({ realtimeEnabled: false });
    expect(mockUseRealtime).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
