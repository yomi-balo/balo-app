'use client';

import { Calendar, Clock, FileText, Loader2, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';
import type { ThreadActions } from './thread-actions';
import { InitialsAvatar } from './initials-avatar';

interface ThreadHeaderProps {
  thread: ConversationThreadView;
  showYouSuffix: boolean;
  fileCount: number;
  filesOpen: boolean;
  actions: ThreadActions;
  callPending: boolean;
  onToggleFiles: () => void;
  onCall: () => void;
  /**
   * The `kind:'request'` proposal CTA handler (client lens, A5). Non-null →
   * the slot renders ENABLED; null → disabled stub.
   */
  onRequestProposal: (() => void) | null;
  /**
   * The `kind:'build'` proposal CTA handler (expert lens, A6.2 — opens the
   * composer). Non-null → the slot renders ENABLED; null → disabled stub.
   */
  onBuildProposal: (() => void) | null;
  /**
   * The `kind:'view'` proposal CTA handler (BAL-289 / A6.3 — opens the read-only
   * review/submitted surface). Non-null → the slot renders ENABLED; null →
   * disabled stub (defensive).
   */
  onViewProposal: (() => void) | null;
}

/**
 * Desktop-only thread header (`hidden lg:flex` applied by the stage): avatar,
 * expert name, Files pill (count), lens-aware call CTA (mock seam) and the
 * proposal slot per the gating matrix. The client's "Request proposal" CTA is
 * LIVE (BAL-272 / A5) when `onRequestProposal` is provided; the expert's "Build
 * proposal" CTA is LIVE (BAL-288 / A6.2) when `onBuildProposal` is provided; the
 * "View proposal"/"View submitted" CTA is LIVE (BAL-289 / A6.3) when
 * `onViewProposal` is provided. Deliberate cut (recorded): no rating/role
 * subline — that data isn't hydrated.
 */
export function ThreadHeader({
  thread,
  showYouSuffix,
  fileCount,
  filesOpen,
  actions,
  callPending,
  onToggleFiles,
  onCall,
  onRequestProposal,
  onBuildProposal,
  onViewProposal,
}: Readonly<ThreadHeaderProps>): React.JSX.Element {
  const { headerProposal } = actions;
  return (
    <div className="border-border flex items-center gap-2.5 border-b px-4 py-3">
      <InitialsAvatar initials={thread.expertInitials} size="md" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-semibold">
          {thread.expertName}
          {showYouSuffix && <span className="text-muted-foreground ml-1.5 text-[11px]">(you)</span>}
        </p>
      </div>

      <button
        type="button"
        onClick={onToggleFiles}
        aria-expanded={filesOpen}
        className={cn(
          'inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border px-3 text-[12.5px] font-semibold transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          filesOpen
            ? 'border-primary/30 bg-primary/5 text-primary'
            : 'border-border bg-card text-muted-foreground hover:text-foreground'
        )}
      >
        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
        Files
        {fileCount > 0 && (
          <span
            className={cn(
              'min-w-[18px] rounded-full px-1.5 py-px text-center text-[11px] font-bold',
              filesOpen ? 'bg-card text-primary' : 'bg-muted text-muted-foreground'
            )}
          >
            {fileCount}
          </span>
        )}
      </button>

      {actions.callAllowed && (
        <button
          type="button"
          onClick={onCall}
          disabled={callPending}
          className="border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border px-3 text-[12.5px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          {callPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {actions.callLabel}
        </button>
      )}

      {headerProposal?.kind === 'pill-requested' && (
        <span className="border-warning/30 bg-warning/10 text-warning animate-in fade-in zoom-in-95 inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold motion-reduce:animate-none">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Proposal requested
        </span>
      )}
      {headerProposal?.kind === 'pill-awaiting' && (
        <span
          aria-disabled="true"
          className="border-border bg-muted/50 text-muted-foreground inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          Awaiting proposal request
        </span>
      )}
      {headerProposal?.kind === 'view' && (
        <button
          type="button"
          onClick={onViewProposal ?? undefined}
          disabled={onViewProposal === null}
          aria-disabled={onViewProposal === null ? true : undefined}
          className={cn(
            'border-primary/30 bg-primary/5 text-primary focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border px-3 text-[12.5px] font-semibold transition-opacity focus-visible:ring-2 focus-visible:outline-none',
            onViewProposal === null ? 'opacity-60' : 'hover:opacity-90'
          )}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {headerProposal.label}
        </button>
      )}
      {headerProposal?.kind === 'request' && (
        <button
          type="button"
          onClick={onRequestProposal ?? undefined}
          disabled={onRequestProposal === null}
          aria-disabled={onRequestProposal === null ? true : undefined}
          className={cn(
            'focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-bold transition-opacity focus-visible:ring-2 focus-visible:outline-none',
            onRequestProposal === null ? 'opacity-60' : 'hover:opacity-90',
            headerProposal.quiet
              ? 'border-primary/30 bg-primary/5 text-primary border'
              : 'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500'
          )}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {headerProposal.label}
        </button>
      )}
      {headerProposal?.kind === 'build' && (
        <button
          type="button"
          onClick={onBuildProposal ?? undefined}
          disabled={onBuildProposal === null}
          aria-disabled={onBuildProposal === null ? true : undefined}
          className={cn(
            'focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-bold transition-opacity focus-visible:ring-2 focus-visible:outline-none',
            onBuildProposal === null ? 'opacity-60' : 'hover:opacity-90',
            headerProposal.quiet
              ? 'border-primary/30 bg-primary/5 text-primary border'
              : 'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500'
          )}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {headerProposal.label}
        </button>
      )}
    </div>
  );
}
