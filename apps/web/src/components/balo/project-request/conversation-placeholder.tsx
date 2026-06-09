import { MessageSquare, Paperclip, Send } from 'lucide-react';
import { RequestCard } from './request-card';

/**
 * Static Phase-2 conversation stage — the VISUAL SHELL ONLY (tab strip + empty
 * message area + disabled composer). A2 (BAL-269) replaces this with the live
 * per-relationship thread (tabs, unread dots, send). Until then it follows the
 * four-states empty pattern: an invitation framed around the action the
 * conversation enables, not its absence.
 */
export function ConversationPlaceholder(): React.JSX.Element {
  return (
    <RequestCard className="flex min-h-[520px] flex-col overflow-hidden">
      {/* Tab strip (A2 makes these per-expert + interactive). */}
      <div className="border-border bg-muted/40 flex items-center gap-2 border-b px-4 py-3">
        <span className="bg-primary/10 text-primary flex h-7 w-7 items-center justify-center rounded-md">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="text-foreground text-sm font-semibold">Conversation</span>
      </div>

      {/* Empty message area — invitation, not absence. */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <span className="bg-muted mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
          <MessageSquare className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-foreground text-sm font-semibold">Your conversation lives here</p>
        <p className="text-muted-foreground mt-1.5 max-w-sm text-sm leading-relaxed">
          Once experts express interest, you&apos;ll message them directly to scope the work, share
          files, and line up a call — all in one place.
        </p>
      </div>

      {/* Disabled composer (A2 wires send). */}
      <div className="border-border flex items-center gap-2 border-t px-4 py-3">
        <button
          type="button"
          disabled
          aria-label="Attach a file"
          className="border-border bg-card text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border opacity-60"
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="border-border bg-muted/40 text-muted-foreground flex-1 rounded-[10px] border px-3.5 py-2.5 text-sm">
          Messaging opens once an expert expresses interest…
        </div>
        <button
          type="button"
          disabled
          aria-label="Send message"
          className="from-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-r to-violet-600 text-white opacity-60 dark:to-violet-500"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </RequestCard>
  );
}
