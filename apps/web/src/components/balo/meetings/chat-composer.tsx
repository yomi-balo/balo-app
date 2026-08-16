'use client';

import { useCallback, useRef, useState } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';
import { MEETING_FILE_ACCEPT } from '@/lib/storage/meeting-file-constraints';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingChatPanelActions } from '@/lib/meetings/meeting-panels';
import { cn } from '@/lib/utils';
import { useMeetingFileUpload } from './use-meeting-file-upload';

/**
 * BAL-437 — the in-call composer.
 *
 * ── ⚠⚠ WHY `MessageComposer` IS NOT REUSED ──────────────────────────────────────────────
 *
 * It hard-codes `CONVERSATION_FILE_ACCEPT` — the WRONG constraint set. A meeting file is
 * governed by `MEETING_FILE_ACCEPT` / `MEETING_ALLOWED_CONTENT_TYPES` / `MAX_MEETING_FILE_BYTES`,
 * which differ, and a composer that presigned against one set while the server verified against
 * the other would reject files at the last step of a three-step upload, mid-call.
 *
 * ⚠⚠ `readOnly` WHILE SENDING, **NEVER `disabled`.** A disabled textarea loses focus, which on
 * a phone dismisses the keyboard — so every message would cost a re-tap, and a failed send
 * would strand the person with a closed keyboard and a draft they cannot see. `readOnly` keeps
 * focus, keeps the keyboard, and keeps the draft if the send fails.
 *
 * ⚠ THE PAPERCLIP USES THE FILE **INPUT** ONLY — it registers no global `dragover`/`drop`
 * swallower. That listener is scoped to the Files panel's lifetime for a reason
 * (`files-panel.tsx`), and a second registration here would legislate browser drag-and-drop for
 * the whole app from inside a chat box.
 *
 * ⚠ THE UPLOAD IS THE SHARED HOOK, BOUND TO `source: 'chat'` UPSTREAM. One definition of
 * "share a file with this call"; the composer cannot see or choose the source.
 */

export interface ChatComposerProps {
  readonly actions: MeetingChatPanelActions;
  /** ⚠ `false` ⇒ READ-ONLY. A closed case's thread stays readable; only this refuses. */
  readonly writable: boolean;
  readonly onSend: (body: string) => Promise<boolean>;
  readonly onFileShared: (file: MeetingFileView) => void;
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  readonly report: (kind: 'success' | 'info' | 'error', message: string) => void;
}

/** ⚠ THE ONE SENTENCE, SHARED WITH `postCaseMessageAction`. Two surfaces, one wording. */
export const CHAT_READ_ONLY_LINE = 'This case is closed, so the conversation is read-only.';

/** Show the counter only when it starts to matter. */
const COUNTER_VISIBLE_FROM = MESSAGE_MAX_TEXT - 200;

export function ChatComposer({
  actions,
  writable,
  onSend,
  onFileShared,
  meetingProps,
  report,
}: Readonly<ChatComposerProps>): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const upload = useMeetingFileUpload({
    actions,
    meetingProps,
    onShared: onFileShared,
    setIsUploading,
    report,
    // ⚠ IT SAYS WHERE THE FILE WENT. From the chat box the person is not looking at the list.
    successMessage: (fileName) => `${fileName} is shared with the call — you'll find it in Files.`,
  });

  const submit = useCallback((): void => {
    const body = draft.trim();
    if (body.length === 0 || isSending) return;
    setIsSending(true);
    void onSend(body)
      .then((ok) => {
        // ⚠ THE DRAFT SURVIVES A FAILURE. Clearing optimistically would delete the only copy
        // of a sentence somebody typed during a live call.
        if (ok) setDraft('');
      })
      .finally(() => setIsSending(false));
  }, [draft, isSending, onSend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Enter sends; Shift+Enter is a newline. ⚠ IME composition is left alone.
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const onPick = useCallback(
    (picked: FileList | null): void => {
      const [file] = Array.from(picked ?? []);
      if (file === undefined) return;
      void upload(file);
    },
    [upload]
  );

  if (!writable) {
    return (
      <p className="text-muted-foreground px-1 py-2 text-center text-[13px] leading-relaxed">
        {CHAT_READ_ONLY_LINE}
      </p>
    );
  }

  const remaining = MESSAGE_MAX_TEXT - draft.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label="Share a file with the call"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={MEETING_FILE_ACCEPT}
          className="sr-only"
          aria-label="Choose a file to share with the call"
          onChange={(event) => {
            onPick(event.target.files);
            // Allow the same file to be picked twice in a row.
            event.target.value = '';
          }}
        />

        {/* ⚠ AN EXPLICIT `<label>` TIED BY `htmlFor`, not a placeholder standing in for one. */}
        <label htmlFor="meeting-chat-composer" className="sr-only">
          Message everyone in the call
        </label>
        <textarea
          id="meeting-chat-composer"
          ref={textareaRef}
          value={draft}
          readOnly={isSending}
          rows={1}
          maxLength={MESSAGE_MAX_TEXT}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message everyone…"
          className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring max-h-28 min-h-11 flex-1 resize-none rounded-xl border px-3 py-2.5 text-sm leading-relaxed focus-visible:ring-2 focus-visible:outline-none"
        />

        {/*
          ⚠⚠ `aria-disabled`, **NEVER `disabled`** — the same rule the textarea's `readOnly`
          follows, for the same reason. A `disabled` button is removed from the tab order and
          loses focus, so a screen-reader user who tabbed to Send and pressed it would find
          focus dumped to the start of the panel for the duration of every send. `aria-disabled`
          announces the unavailability while the control stays reachable and keeps focus;
          `submit` already refuses an empty or in-flight draft, so the attribute describes real
          behaviour rather than enforcing it.

          ⚠ THE ACCESSIBLE NAME CARRIES THE PENDING STATE ("Sending…"). Without it the only
          feedback for a slow send is a slight opacity change, which is invisible to AT and
          nearly invisible to everyone else.
        */}
        <button
          type="button"
          onClick={submit}
          aria-label={isSending ? 'Sending…' : 'Send message'}
          aria-disabled={draft.trim().length === 0 || isSending}
          className={cn(
            'bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-opacity focus-visible:ring-2 focus-visible:outline-none',
            draft.trim().length === 0 || isSending ? 'opacity-60' : 'hover:opacity-90'
          )}
        >
          <SendHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      {isUploading ? (
        <p className="text-muted-foreground px-1 text-[11px]">Sharing your file…</p>
      ) : null}

      {/* ⚠ NO SILENT LIMIT. The counter appears before the cap bites, not at it. */}
      {draft.length >= COUNTER_VISIBLE_FROM ? (
        <p className="text-muted-foreground px-1 text-right text-[11px] tabular-nums">
          {remaining} characters left
        </p>
      ) : null}
    </div>
  );
}
