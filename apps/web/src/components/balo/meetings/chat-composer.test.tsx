import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingChatPanelActions } from '@/lib/meetings/meeting-panels';
import { ChatComposer, CHAT_READ_ONLY_LINE } from './chat-composer';

/**
 * BAL-437 — the in-call composer, including the paperclip.
 *
 * ⚠⚠ THE PAPERCLIP GOES THROUGH THE **SHARED** UPLOAD HOOK, which the Files panel also uses.
 * What is tested here is the CHAT-SPECIFIC half: its own success copy (which must say where the
 * file went, because the person is not looking at the Files list) and that it reaches the same
 * three-step flow. The validation and duplicate-confirm behaviour are the hook's and are
 * covered once, in `files-panel.test.tsx`.
 *
 * ⚠ `readOnly`, NEVER `disabled`, while sending — a disabled textarea loses focus, which on a
 * phone dismisses the keyboard and strands a failed send behind a re-tap.
 */

vi.mock('@/components/balo/document-uploader/upload-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/balo/document-uploader/upload-file')>()),
  putWithProgress: vi.fn().mockResolvedValue(undefined),
}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const MEETING_PROPS = { meeting_id: MEETING_ID };

interface Fakes {
  readonly actions: MeetingChatPanelActions;
  readonly requestUpload: ReturnType<typeof vi.fn>;
  readonly confirmUpload: ReturnType<typeof vi.fn>;
}

function fakes(): Fakes {
  const requestUpload = vi
    .fn()
    .mockResolvedValue({ success: true, presignedUrl: 'https://r2.test/put', key: 'k' });
  const confirmUpload = vi.fn().mockResolvedValue({
    success: true,
    file: {
      id: 'f1',
      meetingId: MEETING_ID,
      fileName: 'deck.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
      party: 'client',
      source: 'chat',
      uploadedByUserId: 'u1',
      createdAtIso: '2026-08-14T09:00:00.000Z',
    },
  });
  return {
    requestUpload,
    confirmUpload,
    actions: {
      fetchThread: vi.fn(),
      postMessage: vi.fn(),
      requestUpload,
      confirmUpload,
    } as unknown as MeetingChatPanelActions,
  };
}

function renderComposer(
  overrides: {
    writable?: boolean;
    onSend?: (body: string) => Promise<boolean>;
    onFileShared?: (file: MeetingFileView) => void;
    report?: (kind: 'success' | 'info' | 'error', message: string) => void;
    fake?: Fakes;
  } = {}
): { container: HTMLElement; fake: Fakes } {
  const fake = overrides.fake ?? fakes();
  const { container } = render(
    <ChatComposer
      actions={fake.actions}
      writable={overrides.writable ?? true}
      onSend={overrides.onSend ?? vi.fn().mockResolvedValue(true)}
      onFileShared={overrides.onFileShared ?? vi.fn()}
      meetingProps={MEETING_PROPS}
      report={overrides.report ?? vi.fn()}
    />
  );
  return { container, fake };
}

/** A `File` of a given type and size — jsdom does not give us a real one. */
function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatComposer — sending', () => {
  it('⚠ Enter sends; Shift+Enter does not', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    renderComposer({ onSend });

    const box = screen.getByLabelText(/message everyone in the call/i);
    await userEvent.type(box, 'Hello');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('⚠ an IME composition Enter never sends — it is committing a character', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    renderComposer({ onSend });

    const box = screen.getByLabelText(/message everyone in the call/i);
    await userEvent.type(box, 'こんにちは');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send an empty or whitespace-only draft', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    renderComposer({ onSend });

    await userEvent.click(screen.getByLabelText('Send message'));
    await userEvent.type(screen.getByLabelText(/message everyone in the call/i), '   ');
    await userEvent.click(screen.getByLabelText('Send message'));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('⚠⚠ is `readOnly` WHILE SENDING, never `disabled` — focus and the keyboard survive', async () => {
    let settle: (value: boolean) => void = () => {};
    const onSend = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      })
    );
    renderComposer({ onSend });

    const box = screen.getByLabelText(/message everyone in the call/i);
    await userEvent.type(box, 'In flight');
    await userEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(box).toHaveAttribute('readonly'));
    expect(box).not.toBeDisabled();

    settle(true);
    await waitFor(() => expect(box).toHaveValue(''));
  });
});

describe('ChatComposer — the character counter', () => {
  it('⚠ stays hidden well below the limit — a counter that is always on is noise', () => {
    renderComposer();

    expect(screen.queryByText(/characters left/i)).not.toBeInTheDocument();
  });

  it('⚠ NO SILENT LIMIT — it appears BEFORE the cap bites, not at it', async () => {
    renderComposer();

    const box = screen.getByLabelText(/message everyone in the call/i);
    // ⚠ `fireEvent`, not `userEvent.type`: typing 3,900 characters one keystroke at a time is
    // minutes of test time for no extra confidence.
    fireEvent.change(box, { target: { value: 'a'.repeat(3900) } });

    expect(await screen.findByText('100 characters left')).toBeInTheDocument();
  });
});

describe('ChatComposer — ⚠⚠ the read-only state', () => {
  it('renders the SHIPPED case-surface sentence and NO composer at all', () => {
    renderComposer({ writable: false });

    expect(screen.getByText(CHAT_READ_ONLY_LINE)).toBeInTheDocument();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/share a file with the call/i)).not.toBeInTheDocument();
  });

  it('⚠ the sentence is the one `postMeetingMessageAction` refuses with — one wording', () => {
    expect(CHAT_READ_ONLY_LINE).toBe('This case is closed, so the conversation is read-only.');
  });
});

describe('ChatComposer — the paperclip', () => {
  it('runs the three-step upload and reports the file to the timeline', async () => {
    const onFileShared = vi.fn();
    const { fake } = renderComposer({ onFileShared });

    const input = screen.getByLabelText(/choose a file to share with the call/i);
    fireEvent.change(input, {
      target: { files: [makeFile('deck.pdf', 'application/pdf', 1000)] },
    });

    await waitFor(() => expect(fake.requestUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fake.confirmUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onFileShared).toHaveBeenCalledTimes(1));
  });

  it('⚠⚠ its success copy SAYS WHERE THE FILE WENT — the person is not looking at Files', async () => {
    const report = vi.fn();
    renderComposer({ report });

    fireEvent.change(screen.getByLabelText(/choose a file to share with the call/i), {
      target: { files: [makeFile('deck.pdf', 'application/pdf', 1000)] },
    });

    await waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        'success',
        "deck.pdf is shared with the call — you'll find it in Files."
      )
    );
  });

  it('tracks the shared file with a SIZE BUCKET and never the name', async () => {
    renderComposer();

    fireEvent.change(screen.getByLabelText(/choose a file to share with the call/i), {
      target: { files: [makeFile('deck.pdf', 'application/pdf', 1000)] },
    });

    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_SHARED, {
        ...MEETING_PROPS,
        outcome: 'ok',
        size_bucket: 'under_100kb',
      })
    );
  });

  it('⚠ rejects an unsupported type BEFORE the presign — no 10 MB round trip to be told no', async () => {
    const report = vi.fn();
    const { fake } = renderComposer({ report });

    fireEvent.change(screen.getByLabelText(/choose a file to share with the call/i), {
      target: { files: [makeFile('virus.exe', 'application/x-msdownload', 1000)] },
    });

    await waitFor(() => expect(report).toHaveBeenCalledWith('error', expect.any(String)));
    expect(fake.requestUpload).not.toHaveBeenCalled();
  });
});

describe('ChatComposer — accessibility', () => {
  it('has no violations, and every control is labelled', async () => {
    const { container } = renderComposer();

    // ⚠ AN EXPLICIT `<label htmlFor>`, not a placeholder standing in for one.
    expect(screen.getByLabelText(/message everyone in the call/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the read-only state', async () => {
    const { container } = renderComposer({ writable: false });

    expect(await axe(container)).toHaveNoViolations();
  });
});
