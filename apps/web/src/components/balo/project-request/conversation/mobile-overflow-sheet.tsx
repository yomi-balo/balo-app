'use client';

import Link from 'next/link';
import { ChevronRight, Clock, User } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';

interface MobileOverflowSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ConversationThreadView;
  /** Client lens + relationship `proposal_requested` — presentational pill. */
  showProposalPill: boolean;
  /** Profile link renders ONLY when a public username is available (never dead). */
  profileHref: string | null;
}

/**
 * True when the sheet has at least one row to show — the stage uses this to
 * decide whether the `⋯` trigger renders at all (never a dead control).
 */
export function hasOverflowContent(input: {
  profileHref: string | null;
  showProposalPill: boolean;
}): boolean {
  return input.profileHref !== null || input.showProposalPill;
}

/**
 * Mobile `⋯` bottom sheet — genuinely secondary actions only (primary actions
 * live in the rail): the expert's public profile + a presentational
 * relationship-status pill.
 */
export function MobileOverflowSheet({
  open,
  onOpenChange,
  thread,
  showProposalPill,
  profileHref,
}: Readonly<MobileOverflowSheetProps>): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} side="bottom" className="gap-0 rounded-t-2xl">
        <SheetHeader className="border-border border-b pb-3">
          <SheetTitle className="text-sm">{thread.expertName}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 p-3 pb-5">
          {profileHref !== null && (
            <Link
              href={profileHref}
              onClick={() => onOpenChange(false)}
              className="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring flex min-h-12 items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                <User className="text-primary h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[13px] font-semibold">
                  View {thread.expertFirstName}&apos;s profile
                </span>
                <span className="text-muted-foreground block text-[11px]">
                  Background, ratings, past work
                </span>
              </span>
              <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          )}
          {showProposalPill && (
            <div className="border-warning/30 bg-warning/10 flex items-center gap-2.5 rounded-xl border px-3.5 py-3">
              <Clock className="text-warning h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-warning text-[13px] font-semibold">
                Proposal requested — awaiting submission
              </span>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
