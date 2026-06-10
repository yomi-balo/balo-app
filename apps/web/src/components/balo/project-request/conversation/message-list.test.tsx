import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
}));

import { MessageList } from './message-list';
import { thread } from '@/test/fixtures/conversation';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/project-request/conversation-view-types';

const VIEWER_ID = 'user-viewer';

function msg(id: string, at: string, sender = 'user-expert'): ConversationMessageView {
  return {
    id,
    relationshipId: 'rel-1',
    bodyHtml: `<p>body ${id}</p>`,
    senderUserId: sender,
    senderName: 'Priya Nair',
    createdAtIso: at,
  };
}

function file(id: string, at: string, uploader = 'user-expert'): ConversationFileView {
  return {
    id,
    relationshipId: 'rel-1',
    fileName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    uploadedByUserId: uploader,
    uploadedByName: 'Priya Nair',
    createdAtIso: at,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}): {
  onLoadEarlier: ReturnType<typeof vi.fn>;
  onRetry: ReturnType<typeof vi.fn>;
  onFileClick: ReturnType<typeof vi.fn>;
} {
  const onLoadEarlier = vi.fn();
  const onRetry = vi.fn();
  const onFileClick = vi.fn();
  render(
    <MessageList
      thread={thread()}
      lens="client"
      viewerUserId={VIEWER_ID}
      state="ready"
      messages={[]}
      files={[]}
      hasEarlier={false}
      loadingEarlier={false}
      downloadingFileId={null}
      onLoadEarlier={onLoadEarlier}
      onRetry={onRetry}
      onFileClick={onFileClick}
      {...overrides}
    />
  );
  return { onLoadEarlier, onRetry, onFileClick };
}

describe('MessageList — four states', () => {
  it('renders skeleton bubbles while loading', () => {
    renderList({ state: 'loading' });
    expect(screen.getByText('Loading conversation…')).toBeInTheDocument();
  });

  it('renders the inline error state and Retry fires', async () => {
    const user = userEvent.setup();
    const { onRetry } = renderList({ state: 'error' });
    expect(screen.getByText(/Couldn't load this conversation/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders the empty invitation when nothing has been shared', () => {
    renderList();
    expect(screen.getByText('Start the conversation with Priya')).toBeInTheDocument();
  });

  it('expert lens empty state addresses the client', () => {
    renderList({ lens: 'expert' });
    expect(screen.getByText('Start the conversation with the client')).toBeInTheDocument();
  });
});

describe('MessageList — timeline', () => {
  it('merges messages and files chronologically', () => {
    renderList({
      messages: [msg('m-2', '2026-06-09T12:00:00.000Z'), msg('m-1', '2026-06-09T10:00:00.000Z')],
      files: [file('f-1', '2026-06-09T11:00:00.000Z')],
    });
    const texts = screen.getAllByText(/body m-|f-1\.pdf/).map((el) => el.textContent ?? '');
    expect(texts).toEqual(['body m-1', 'f-1.pdf', 'body m-2']);
  });

  it('clicking a file bubble requests its download', async () => {
    const user = userEvent.setup();
    const { onFileClick } = renderList({ files: [file('f-1', '2026-06-09T11:00:00.000Z')] });
    await user.click(screen.getByRole('button', { name: /f-1\.pdf/ }));
    expect(onFileClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-1' }));
  });

  it('shows Load earlier only when an earlier page exists, and fires it', async () => {
    const user = userEvent.setup();
    const { onLoadEarlier } = renderList({
      messages: [msg('m-1', '2026-06-09T10:00:00.000Z')],
      hasEarlier: true,
    });
    await user.click(screen.getByRole('button', { name: /Load earlier/ }));
    expect(onLoadEarlier).toHaveBeenCalled();
  });

  it('hides Load earlier on a fully-loaded thread', () => {
    renderList({ messages: [msg('m-1', '2026-06-09T10:00:00.000Z')] });
    expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument();
  });

  it('pins the EOI intro card (client lens, fully loaded) above the timeline', () => {
    renderList({
      thread: thread({ eoiHtml: '<p>The pitch</p>' }),
      messages: [msg('m-1', '2026-06-09T10:00:00.000Z')],
    });
    expect(screen.getByText('Expression of interest')).toBeInTheDocument();
    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('The pitch');
  });

  it('hides the EOI intro card while earlier pages remain', () => {
    renderList({
      thread: thread({ eoiHtml: '<p>The pitch</p>' }),
      messages: [msg('m-1', '2026-06-09T10:00:00.000Z')],
      hasEarlier: true,
    });
    expect(screen.queryByText('Expression of interest')).not.toBeInTheDocument();
  });

  it('never shows the EOI card on the expert lens (eoiHtml is null there)', () => {
    renderList({ lens: 'expert', messages: [msg('m-1', '2026-06-09T10:00:00.000Z')] });
    expect(screen.queryByText('Expression of interest')).not.toBeInTheDocument();
  });
});

describe('MessageList — "Load earlier" scroll anchoring', () => {
  function baseProps(
    overrides: Partial<React.ComponentProps<typeof MessageList>> = {}
  ): React.ComponentProps<typeof MessageList> {
    return {
      thread: thread(),
      lens: 'client',
      viewerUserId: VIEWER_ID,
      state: 'ready',
      messages: [msg('m-1', '2026-06-09T10:00:00.000Z')],
      files: [],
      hasEarlier: true,
      loadingEarlier: false,
      downloadingFileId: null,
      onLoadEarlier: vi.fn(),
      onRetry: vi.fn(),
      onFileClick: vi.fn(),
      ...overrides,
    };
  }

  function setScrollHeight(el: HTMLElement, value: number): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value });
  }

  it('offsets scrollTop by the height delta after a prepend (viewport never jumps)', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { container, rerender } = render(<MessageList {...props} />);
    const scroller = container.querySelector('div.overflow-y-auto');
    expect(scroller).not.toBeNull();
    const el = scroller as HTMLDivElement;

    // The user has scrolled up to read history (sticky-bottom disengages).
    setScrollHeight(el, 1000);
    el.scrollTop = 200;
    fireEvent.scroll(el);

    // Click captures the pre-prepend anchor, then the page lands.
    await user.click(screen.getByRole('button', { name: /Load earlier/ }));
    rerender(<MessageList {...props} loadingEarlier />);
    setScrollHeight(el, 1600);
    rerender(
      <MessageList
        {...props}
        loadingEarlier={false}
        hasEarlier={false}
        messages={[msg('m-0', '2026-06-08T10:00:00.000Z'), ...props.messages]}
      />
    );

    // 200 + (1600 - 1000) — the same content stays under the viewport.
    expect(el.scrollTop).toBe(800);
  });

  it('restores the captured position when the fetch fails (delta 0)', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { container, rerender } = render(<MessageList {...props} />);
    const el = container.querySelector('div.overflow-y-auto') as HTMLDivElement;

    setScrollHeight(el, 1000);
    el.scrollTop = 300;
    fireEvent.scroll(el);

    await user.click(screen.getByRole('button', { name: /Load earlier/ }));
    rerender(<MessageList {...props} loadingEarlier />);
    rerender(<MessageList {...props} loadingEarlier={false} />);

    expect(el.scrollTop).toBe(300);
  });
});
