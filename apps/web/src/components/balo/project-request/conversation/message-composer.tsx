'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Loader2, Paperclip, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONVERSATION_FILE_ACCEPT } from '@/lib/storage/conversation-file-constraints';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';

interface MessageComposerProps {
  expertFirstName: string;
  /** Nudge-driven placeholder override (design's `placeholder.prefill`). */
  placeholder?: string;
  /** Zero-open-threads / gated state — everything disabled. */
  disabled?: boolean;
  /** Lens-aware copy for the disabled state (defaults to the client framing). */
  disabledPlaceholder?: string;
  sending: boolean;
  /** Live upload, if any — drives the inline progress strip. */
  uploading: { fileName: string; progress: number } | null;
  /** Controlled draft — the STAGE owns per-thread drafts (one per relationship). */
  value: string;
  onChange: (text: string) => void;
  /** Resolves `true` when sent (the stage clears that thread's draft); `false` keeps it. */
  onSend: (text: string) => Promise<boolean>;
  onAttach: (file: File) => void;
  onFocusChange?: (focused: boolean) => void;
}

const TEXTAREA_MAX_HEIGHT_PX = 160;
/** Show the character counter once the draft is within this many chars of the cap. */
const COUNTER_VISIBLE_FROM = MESSAGE_MAX_TEXT - 200;

/**
 * Plain-text composer (D4 — no rich-text toolbar): auto-growing textarea,
 * Enter sends / Shift+Enter newline, attach button driving the presign → XHR
 * PUT → confirm pipeline, gradient send button. CONTROLLED: the stage owns the
 * draft per thread, so switching tabs swaps drafts instead of leaking one
 * thread's reply into another. While sending the textarea is `readOnly` (not
 * disabled) so focus — and the mobile keyboard — survive the round trip; the
 * draft survives failures. Over-limit drafts (> MESSAGE_MAX_TEXT plain chars)
 * are blocked client-side with an inline error — no server call.
 */
export function MessageComposer({
  expertFirstName,
  placeholder,
  disabled = false,
  disabledPlaceholder,
  sending,
  uploading,
  value,
  onChange,
  onSend,
  onAttach,
  onFocusChange,
}: Readonly<MessageComposerProps>): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, []);

  // The draft can change from OUTSIDE (thread switch, post-send clear) — keep
  // the textarea height in sync with whatever value is rendered.
  useEffect(() => {
    autoGrow();
  }, [value, autoGrow]);

  const draftLength = value.trim().length;
  const overLimit = draftLength > MESSAGE_MAX_TEXT;
  const showCounter = draftLength >= COUNTER_VISIBLE_FROM;

  const submit = useCallback((): void => {
    const text = value.trim();
    if (text.length === 0 || text.length > MESSAGE_MAX_TEXT || sending || disabled) return;
    onSend(text)
      .then((sent) => {
        if (sent) {
          // The stage cleared the thread's draft; keep the writing flow alive.
          textareaRef.current?.focus();
        }
      })
      .catch(() => {
        // The stage toasts; the draft stays.
      });
  }, [value, sending, disabled, onSend]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      if (sending) return; // readOnly guards typing; belt-and-braces for IME edge cases.
      onChange(event.target.value);
    },
    [onChange, sending]
  );

  const handleAttachClick = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const [file] = Array.from(event.target.files ?? []);
      if (file !== undefined) onAttach(file);
      // Allow re-selecting the same file.
      event.target.value = '';
    },
    [onAttach]
  );

  const handleFocus = useCallback((): void => onFocusChange?.(true), [onFocusChange]);
  const handleBlur = useCallback((): void => onFocusChange?.(false), [onFocusChange]);

  const isUploading = uploading !== null;

  return (
    <div className="border-border border-t">
      {isUploading && (
        <div className="border-border bg-muted/40 flex items-center gap-2.5 border-b px-4 py-2">
          <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            Sharing {uploading.fileName}…
          </span>
          <span className="text-muted-foreground text-xs font-semibold tabular-nums">
            {uploading.progress}%
          </span>
        </div>
      )}
      <div className="flex items-end gap-2 px-3.5 py-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={CONVERSATION_FILE_ACCEPT}
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <button
          type="button"
          onClick={handleAttachClick}
          disabled={disabled || isUploading}
          aria-label="Attach a file"
          className="border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          readOnly={sending}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          aria-label={`Message ${expertFirstName}`}
          aria-invalid={overLimit || undefined}
          aria-describedby={overLimit ? 'composer-limit-error' : undefined}
          placeholder={
            disabled
              ? (disabledPlaceholder ?? 'Messaging opens once an expert expresses interest…')
              : (placeholder ?? `Message ${expertFirstName}…`)
          }
          className={cn(
            'border-border bg-card text-foreground placeholder:text-muted-foreground min-h-11 min-w-0 flex-1 resize-none rounded-[10px] border px-3.5 py-2.5 text-sm leading-relaxed',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60',
            overLimit && 'border-destructive/50'
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || sending || overLimit || value.trim().length === 0}
          aria-label="Send message"
          className="from-primary focus-visible:ring-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-r to-violet-600 text-white transition-opacity focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 dark:to-violet-500"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {(overLimit || showCounter) && (
        <div className="flex items-center justify-between gap-3 px-3.5 pb-2.5" role="status">
          {overLimit ? (
            <p id="composer-limit-error" className="text-destructive text-xs font-medium">
              Keep your message under {MESSAGE_MAX_TEXT.toLocaleString('en-US')} characters.
            </p>
          ) : (
            <span aria-hidden="true" />
          )}
          <span
            className={cn(
              'text-xs tabular-nums',
              overLimit ? 'text-destructive font-semibold' : 'text-muted-foreground'
            )}
          >
            {draftLength.toLocaleString('en-US')}/{MESSAGE_MAX_TEXT.toLocaleString('en-US')}
          </span>
        </div>
      )}
    </div>
  );
}
