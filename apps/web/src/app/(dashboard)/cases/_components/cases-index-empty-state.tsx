'use client';

import Link from 'next/link';
import { FolderKanban, Lock, SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * BAL-567 — the index's four non-list states: empty (either side), expert setup incomplete, the
 * company LOCK state, and a failed read.
 *
 * ⚠⚠ THE LOCK STATE IS NOT AN EMPTY LIST, AND THE DIFFERENCE IS THE WHOLE POINT. A company
 * member whose role does not carry `PARTICIPATE` can open NO case, so telling them "no cases
 * yet" would be false. It is the FAIL-CLOSED branch of the loader's capability gate, and it is
 * UNREACHABLE by construction as of this commit (D9: all three shipped company roles grant
 * `PARTICIPATE`) — which is exactly why it is covered here, by a test that renders it directly,
 * rather than by a fixture manufactured to reach it.
 *
 * ⚠ EACH STATE EITHER OFFERS AN ACTION OR HONESTLY HAS NONE (balo-ui's empty-state rule). The
 * client's empty state invites booking; the expert's incomplete-setup state points at setup; the
 * expert's plain empty state offers nothing, because there is genuinely nothing an expert can do
 * to make a client book — inventing a CTA there would be worse than its absence.
 */

interface CasesIndexEmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
  /** Rendered only as a pair — an action with no destination is not rendered at all. */
  readonly actionLabel?: string;
  readonly actionHref?: string;
  readonly onActionClick?: () => void;
  /** The lock state's icon is muted rather than brand-tinted: it is not an invitation. */
  readonly tone?: 'invite' | 'locked';
}

export function CasesIndexEmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  actionHref,
  onActionClick,
  tone = 'invite',
}: Readonly<CasesIndexEmptyStateProps>): React.JSX.Element {
  const hasAction = actionLabel !== undefined && actionHref !== undefined;
  return (
    <div className="border-border bg-card rounded-2xl border px-6 py-11 text-center">
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-12 items-center justify-center rounded-2xl',
          tone === 'locked' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'
        )}
      >
        <Icon className="size-[22px]" />
      </span>
      <p className="text-foreground mt-3.5 text-base font-semibold">{title}</p>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-[420px] text-sm leading-relaxed">
        {body}
      </p>
      {hasAction && (
        <div className="mt-4.5">
          <Button asChild>
            <Link href={actionHref} onClick={onActionClick}>
              {actionLabel}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Re-exported so the shell imports its icons from one place with the state they belong to. */
export const CASES_INDEX_EMPTY_ICONS = {
  empty: FolderKanban,
  setup: SlidersHorizontal,
  locked: Lock,
} as const;
