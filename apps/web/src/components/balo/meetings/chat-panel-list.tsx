'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { MessageBubbleHtml } from '@/components/balo/conversation/message-bubble-html';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import { cn } from '@/lib/utils';

/**
 * BAL-437 — the in-call chat timeline.
 *
 * ── ⚠⚠ WHY THIS IS **NOT** `components/balo/conversation/message-list.tsx` ──────────────
 *
 * Two independent reasons, and the first is mechanical: that component takes a prop literally
 * named `lens`, and `meeting-call-no-lens-gate.test.ts` bans the substring `lens` in EVERY file
 * under `components/balo/meetings`. Rendering `<MessageList lens={…} />` from here fails the
 * build — which is the invariant working exactly as designed, because `lens` there is a
 * PROJECT-REQUEST view selector and a call surface has no lens.
 *
 * Independently: `MessageList` carries the EOI intro card and a merged CONVERSATION-file
 * timeline, both project-request concerns that have no meaning inside a call.
 *
 * ⚠ WHAT **IS** REUSED: `MessageBubbleHtml`, the sanitised-body renderer. It takes no `lens`,
 * mounts no editor, and is the one place `dangerouslySetInnerHTML` is allowed for a message.
 *
 * ── ⚠⚠ THE INLINE FILE ROW IS A **VIEW OVER `meeting_files`**, NOT A SECOND STORE ───────
 *
 * A paperclip sitting inside the composer that visibly does nothing to the thread above it is
 * the confusing case, so a chat-shared file DOES appear here. But:
 *
 *   · it is filtered to `source: 'chat'` — a file dropped on the FILES panel was not *said* in
 *     the conversation, and showing it here would make that drop zone a second way to post;
 *   · there is NO `conversation_files` row, no new table, no duplicated blob and no second
 *     `source` value. BAL-423's D0 ("one unified list") is about the STORE, and the store is
 *     untouched;
 *   · ⚠⚠ **IT IS NOT A DOWNLOAD CONTROL.** It shows name + size and links INTO the Files panel.
 *     Download stays in one place, behind one presigned-URL action, with one authorization
 *     path. Do not add a second download entry point here.
 *
 * ⚠ ORDERING IS DETERMINISTIC: `created_at` ascending, and a file sorts AFTER a message sharing
 * its exact instant. Not a preference — a stable order is what makes the assertion in
 * `chat-panel.test.tsx` meaningful rather than flaky.
 */

export type ChatTimelineItem =
  | { readonly kind: 'message'; readonly at: string; readonly message: ConversationMessageView }
  | { readonly kind: 'file'; readonly at: string; readonly file: MeetingFileView };

/** ⚠ The tie-break: message (0) before file (1) at the same instant. */
function rank(item: ChatTimelineItem): number {
  return item.kind === 'message' ? 0 : 1;
}

/**
 * Merge the two reads into one chronological timeline.
 *
 * ⚠ A PURE MODULE FUNCTION, EXPORTED FOR ITS OWN TEST — the ordering rule is the part most
 * likely to be "tidied" into something unstable.
 */
export function mergeChatTimeline(
  messages: readonly ConversationMessageView[],
  files: readonly MeetingFileView[]
): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [
    ...messages.map(
      (message): ChatTimelineItem => ({ kind: 'message', at: message.createdAtIso, message })
    ),
    ...files
      // ⚠ `chat` ONLY. See the module docblock.
      .filter((file) => file.source === 'chat')
      .map((file): ChatTimelineItem => ({ kind: 'file', at: file.createdAtIso, file })),
  ];
  items.sort((a, b) => (a.at === b.at ? rank(a) - rank(b) : a.at.localeCompare(b.at)));
  return items;
}

export interface ChatPanelListProps {
  readonly items: readonly ChatTimelineItem[];
  /** ⚠ THE ONLY IDENTITY THIS COMPONENT GETS, and it is used for alignment and nothing else. */
  readonly viewerUserId: string;
  readonly hasEarlier: boolean;
  readonly isLoadingEarlier: boolean;
  /** ⚠ A FAILED "Show earlier" SAYS SO INLINE. A control that visibly does nothing reads broken. */
  readonly earlierFailed: boolean;
  readonly onLoadEarlier: () => void;
  /** Opens the Files panel. ⚠ The panel is single-slot, so this is a slot SWAP, not a stack. */
  readonly onOpenFiles: () => void;
}

/** The id of the LAST item, or `null`. ⚠ THE APPEND SIGNAL — see {@link useTimelineScroll}. */
function lastItemIdOf(items: readonly ChatTimelineItem[]): string | null {
  const last = items.at(-1);
  if (last === undefined) return null;
  return last.kind === 'message' ? last.message.id : last.file.id;
}

/**
 * The nearest scrollable ancestor, or `null`.
 *
 * ⚠ THE PANEL SHELL OWNS THE SCROLL BOX (`meeting-side-panel.tsx`'s
 * `min-h-0 flex-1 overflow-y-auto`), not this component, so a prepend has to find it by walking
 * up. ⚠ IT IS FOUND BY COMPUTED `overflow-y`, NEVER BY CLASS NAME — a Tailwind class is a
 * spelling, and asserting on one would break the moment the shell restyles.
 */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  for (
    let current = node?.parentElement ?? null;
    current !== null;
    current = current.parentElement
  ) {
    const overflowY = globalThis.getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
  }
  return null;
}

/**
 * ⚠⚠ **STICK TO THE BOTTOM ON AN APPEND — NEVER ON A PREPEND.**
 *
 * The previous rule was "scroll when `items.length` GREW", which is true of BOTH operations.
 * `loadEarlier` PREPENDS an older page, so pressing "Show earlier messages" grew the array and
 * immediately scrolled the person back to the newest message — i.e. the one control whose entire
 * purpose is to move them AWAY from the bottom put them straight back at it. The button was
 * functionally unusable, and a count cannot tell the two cases apart.
 *
 * The LAST item's id can: an append changes it, a prepend does not. On a prepend the fix is the
 * mirror image — capture `scrollHeight` before the DOM grows and restore the delta after, so the
 * message they were reading stays exactly where it was under their eyes.
 *
 * ⚠ THE PREPEND BRANCH IS A **LAYOUT EFFECT**, deliberately: it must run before paint, or the
 * viewport visibly jumps to the top and snaps back.
 *
 * ⚠⚠ **THAT LAYOUT EFFECT CARRIES NO DEPENDENCY ARRAY, AND THAT IS THE CORRECTNESS HALF OF THE
 * FIX RATHER THAN AN OVERSIGHT.** It re-measures on EVERY commit, so `heightBeforeRef` always
 * holds the height as of the commit immediately before this one — which is what "the height
 * before the update" has to mean. Keyed on `[count, lastId]` it instead held the height as of the
 * last commit that changed the ITEM LIST, and at least one height-changing commit always lands in
 * between: pressing the control flips `isLoadingEarlier`, which re-labels the button
 * ("Show earlier messages" → "Loading earlier messages…", a longer string that wraps in a narrow
 * in-call panel), and a retry after a failure removes the `earlierFailed` line. Every such commit
 * left the restore off by that many pixels — a smaller version of the very jump this exists to
 * prevent. The restore itself is still gated on `grew && !appended`, so re-measuring costs a
 * `scrollHeight` read and moves nothing.
 */
function useTimelineScroll(items: readonly ChatTimelineItem[]): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const countRef = useRef(0);
  /** `scrollHeight` captured on the render BEFORE a prepend landed. */
  const heightBeforeRef = useRef<number | null>(null);

  const lastId = lastItemIdOf(items);
  const count = items.length;

  // ⚠ CAPTURE DURING THE COMMIT THAT PRECEDES THE GROWTH — reading `scrollHeight` after the DOM
  // has already grown would measure the wrong number.
  // ⚠⚠ NO DEPENDENCY ARRAY, ON PURPOSE — every commit re-measures, so the captured height is
  // never stale by a re-render that changed the panel's height without changing the item list
  // (the `isLoadingEarlier` label swap does exactly that, on every use of the control). See the
  // hook's docblock. The restore stays gated on `grew && !appended`.
  useLayoutEffect(() => {
    const grew = count > countRef.current;
    const appended = lastId !== lastIdRef.current;
    const scroller = scrollParentOf(containerRef.current);

    if (grew && !appended && scroller !== null && heightBeforeRef.current !== null) {
      // ⚠ A PREPEND: hold the reading position by the exact height the timeline gained.
      scroller.scrollTop += scroller.scrollHeight - heightBeforeRef.current;
    }

    heightBeforeRef.current = scroller?.scrollHeight ?? null;
    countRef.current = count;
  });

  useEffect(() => {
    // ⚠ AN APPEND ONLY. `lastId` changing is the append signal; a prepend leaves it alone, and
    // the very first render (`null` → an id) is an append too, which is what we want on open.
    if (lastId !== lastIdRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
    lastIdRef.current = lastId;
  }, [lastId]);

  return { containerRef, bottomRef };
}

export function ChatPanelList({
  items,
  viewerUserId,
  hasEarlier,
  isLoadingEarlier,
  earlierFailed,
  onLoadEarlier,
  onOpenFiles,
}: Readonly<ChatPanelListProps>): React.JSX.Element {
  const { containerRef, bottomRef } = useTimelineScroll(items);

  return (
    /*
      ⚠⚠ `role="log"` — AN ASSISTIVE-TECH USER **WITH THE PANEL OPEN** IS TOLD WHEN SOMEBODY
      SPEAKS. Nothing else tells them: `unreadChat` is force-cleared while the panel is open (so
      the toolbar's "Chat, new messages" suffix never appears), and the hook's `onMessage`
      deliberately does not announce through the frame's §16 region — that region is for
      MUTATION OUTCOMES, and routing chat through it would mix "your file was shared" with
      other people's sentences in one queue.

      `log` is the right role rather than a bare `aria-live`: it is the ARIA role for a
      chronological, append-only record, and it carries `aria-live="polite"` implicitly, so an
      arrival waits for a pause instead of interrupting the call audio.

      ⚠ THE ANNOUNCEMENT IS THE **SENDER AND THE BODY**, not "a new message" — because the whole
      row is inside the region, the name span and the bubble are both read out. A generic
      notification would force the person to open something to find out what was said, which on
      a live call is the opposite of what the role is for.

      ⚠ NO `aria-atomic`: the default (`false`) announces only the ADDED node. `true` would
      re-read the entire thread on every message.
    */
    <div
      ref={containerRef}
      role="log"
      aria-label="Chat messages"
      className="flex flex-col gap-2.5 p-3"
    >
      {hasEarlier ? (
        <button
          type="button"
          onClick={onLoadEarlier}
          className="border-border text-muted-foreground hover:bg-muted/60 focus-visible:ring-ring mx-auto inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {/* ⚠ "Loading earlier messages…", not "Loading…" — the panel has two reads and a bare
              "Loading…" beside a live thread does not say which one is in flight. */}
          {isLoadingEarlier ? 'Loading earlier messages…' : 'Show earlier messages'}
        </button>
      ) : null}

      {earlierFailed ? (
        <p className="text-muted-foreground mx-auto text-center text-[11px] leading-relaxed">
          We couldn&apos;t load the earlier messages. Try that again.
        </p>
      ) : null}

      {items.map((item) =>
        item.kind === 'message' ? (
          <ChatMessageRow
            key={item.message.id}
            message={item.message}
            isOwn={item.message.senderUserId === viewerUserId}
          />
        ) : (
          <ChatFileRow key={item.file.id} file={item.file} onOpenFiles={onOpenFiles} />
        )
      )}

      {/* The scroll anchor. Decoration only. */}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

function ChatMessageRow({
  message,
  isOwn,
}: Readonly<{ message: ConversationMessageView; isOwn: boolean }>): React.JSX.Element {
  return (
    <div className={cn('flex w-full flex-col gap-1', isOwn ? 'items-end' : 'items-start')}>
      {/* ⚠ THE NAME IS ALWAYS RENDERED, on both sides. On a call with a guest-free member
          roster the sender is still worth naming: an unattributed bubble in a two-party thread
          is readable, in a four-party one it is not. */}
      <span className="text-muted-foreground px-1 text-[11px] font-medium">
        {isOwn ? 'You' : message.senderName}
      </span>
      <MessageBubbleHtml
        html={message.bodyHtml}
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2',
          isOwn ? 'bg-primary/15 text-foreground' : 'bg-muted text-foreground'
        )}
      />
    </div>
  );
}

/**
 * The inline "shared a file" row.
 *
 * ⚠ THE CONTROL SAYS **"View in Files"** AND OPENS THE PANEL. It is not a download, and its
 * accessible name includes the file name so a screen-reader user hears which file the control
 * belongs to rather than six identical "View in Files" buttons.
 */
function ChatFileRow({
  file,
  onOpenFiles,
}: Readonly<{ file: MeetingFileView; onOpenFiles: () => void }>): React.JSX.Element {
  return (
    <div className="border-border bg-muted/30 flex items-center gap-2.5 rounded-xl border p-2.5">
      <Paperclip className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-[13px] font-medium">{file.fileName}</span>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {formatBytes(file.sizeBytes)}
        </span>
      </span>
      <button
        type="button"
        onClick={onOpenFiles}
        aria-label={`View ${file.fileName} in Files`}
        className="text-primary hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        View in Files
      </button>
    </div>
  );
}
