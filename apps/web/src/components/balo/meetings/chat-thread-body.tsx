import { ChatPanelList, mergeChatTimeline } from './chat-panel-list';
import { PanelErrorCard, PanelSkeletonRows } from './panel-states';

/**
 * BAL-445 fix-round-1 (F5 / SUGGESTION-3) — `ChatThreadBody` EXTRACTED OUT OF `chat-panel.tsx`
 * INTO ITS OWN MODULE.
 *
 * ⚠⚠ WHY THIS FILE EXISTS RATHER THAN BEING RE-INLINED THERE: ES modules resolve their WHOLE
 * import graph, not just the export a caller asked for. `chat-panel.tsx` module-level imports
 * `ChatComposer` (`./chat-composer`) for `ChatPanel` itself, and `chat-composer.tsx` imports
 * `useMeetingFileUpload` — so `GuestChatPanel` importing `ChatThreadBody` FROM `./chat-panel`
 * dragged the composer AND the upload hook into the read-only guest surface's bundle, purely as
 * a side effect of module resolution, with NOTHING in that graph ever called. It also grew the
 * admitted-mount test's module graph (`meeting-frame-impl → guest-chat-panel → chat-panel →
 * chat-composer → use-meeting-file-upload`) enough to blow past `waitFor`'s 1000ms default under
 * worker contention (CRITICAL-6).
 *
 * Splitting the shared body into its OWN file, with no import of the composer anywhere in its
 * transitive closure, makes "a guest cannot upload or post" a MODULE-GRAPH FACT rather than a
 * props convention: the guest panel's bundle simply cannot reach `chat-composer.tsx` or
 * `use-meeting-file-upload.tsx` through this path. `chat-panel.tsx` re-exports
 * `ChatThreadBody`/`ChatThreadBodyProps` from here so `ChatPanel`'s own render body needs no
 * import-site change.
 */
export interface ChatThreadBodyProps {
  /** The realtime/freshness status line, or `null` for a healthy live transport. */
  readonly statusLine: string | null;
  readonly isLoading: boolean;
  readonly hasFailed: boolean;
  readonly onRetry: () => void;
  readonly errorBody: string;
  /** `null` before the first successful load — gates BOTH the empty line and the list. */
  readonly hasLoaded: boolean;
  readonly items: readonly ReturnType<typeof mergeChatTimeline>[number][];
  readonly emptyNode: React.ReactNode;
  readonly viewerUserId: string | null;
  readonly hasEarlier: boolean;
  readonly isLoadingEarlier: boolean;
  readonly earlierFailed: boolean;
  readonly onLoadEarlier: () => void;
  readonly onOpenFiles: () => void;
}

/**
 * BAL-445 — the shared thread body: status line / skeleton / error card / empty line / rows.
 * Extracted so the member panel (composer footer + realtime feed) and the read-only guest
 * panel (neither) render the SAME list logic rather than a second, drifting copy — the
 * `npx jscpd` duplication gate is why this exists as its own export.
 */
export function ChatThreadBody({
  statusLine,
  isLoading,
  hasFailed,
  onRetry,
  errorBody,
  hasLoaded,
  items,
  emptyNode,
  viewerUserId,
  hasEarlier,
  isLoadingEarlier,
  earlierFailed,
  onLoadEarlier,
  onOpenFiles,
}: Readonly<ChatThreadBodyProps>): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {statusLine === null ? null : (
        <p className="text-muted-foreground border-border border-b px-3 py-2 text-[11px] leading-relaxed">
          {statusLine}
        </p>
      )}

      {isLoading ? <PanelSkeletonRows /> : null}

      {hasFailed ? (
        <PanelErrorCard
          title="We couldn't load the conversation"
          body={errorBody}
          onRetry={onRetry}
        />
      ) : null}

      {hasLoaded && items.length === 0 ? emptyNode : null}

      {hasLoaded && items.length > 0 ? (
        <ChatPanelList
          items={items}
          viewerUserId={viewerUserId}
          hasEarlier={hasEarlier}
          isLoadingEarlier={isLoadingEarlier}
          earlierFailed={earlierFailed}
          onLoadEarlier={onLoadEarlier}
          onOpenFiles={onOpenFiles}
        />
      ) : null}
    </div>
  );
}
