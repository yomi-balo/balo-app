'use client';

import { cn } from '@/lib/utils';
import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';
import { InitialsAvatar } from './initials-avatar';

interface ThreadTabsProps {
  threads: ConversationThreadView[];
  activeThreadId: string | null;
  /** Expert lens — the single tab is the viewer themselves. */
  showYouSuffix: boolean;
  onSelect: (relationshipId: string) => void;
  className?: string;
}

/**
 * The per-expert tab strip. Order is `threads` VERBATIM (invite order — never
 * reordered by activity). Unread = pulsing primary dot. Horizontal scroll on
 * narrow viewports; the stage decides when the strip renders (desktop hides it
 * for a single thread, mobile always shows it — the tab IS the identity).
 */
export function ThreadTabs({
  threads,
  activeThreadId,
  showYouSuffix,
  onSelect,
  className,
}: Readonly<ThreadTabsProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'scrollbar-none flex min-w-0 flex-1 gap-0.5 overflow-x-auto px-2 pt-1.5',
        className
      )}
    >
      {threads.map((thread) => {
        const isActive = thread.relationshipId === activeThreadId;
        return (
          <button
            key={thread.relationshipId}
            type="button"
            onClick={() => onSelect(thread.relationshipId)}
            aria-pressed={isActive}
            className={cn(
              'flex min-h-11 shrink-0 items-center gap-2 rounded-t-[10px] border-b-2 px-3 whitespace-nowrap transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              isActive
                ? 'border-primary bg-card text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent bg-transparent'
            )}
          >
            <InitialsAvatar initials={thread.expertInitials} size="sm" />
            <span className={cn('text-[13px]', isActive ? 'font-semibold' : 'font-medium')}>
              {thread.expertFirstName}
              {showYouSuffix && (
                <span className="text-muted-foreground ml-1 text-[10px]">(you)</span>
              )}
            </span>
            {thread.unread && (
              <span
                className="bg-primary h-2 w-2 animate-pulse rounded-full motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {thread.unread && <span className="sr-only">Unread activity</span>}
          </button>
        );
      })}
    </div>
  );
}
