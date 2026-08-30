import Link from 'next/link';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  CircleCheck,
  ListChecks,
  Timer,
} from 'lucide-react';
import { InfoNote } from '@/components/balo/section/section-states';
import { MoneyBlock } from '@/components/balo/recap/money-block';
import type { RecapHeaderView, RecapMoneyView } from '@/lib/meetings/recap-view-types';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { RecapStatusChip } from './recap-status-chip';

/**
 * BAL-388 §R1–§R3 — eyebrow, title, status chip, meta line and the money line.
 *
 * ⚠ THE BACK LINK EXISTS NOW, AND ONLY ON A `case` RECAP. This docblock previously read "NO
 * BACK LINK … BAL-421's case surface and `/cases` do not exist, and a link to nowhere is worse
 * than none" — BAL-421 built that surface, so the condition that justified the absence is
 * gone. The rule it was an instance of is UNCHANGED and still enforced: `header.caseHref` is
 * `null` for every NON-`case` context (whose `contextId` is not an `engagements.id`, so
 * `/cases/[engagementId]` could not resolve it), and a `null` renders NO element — never a
 * disabled or dead link. The EYEBROW still carries identification on its own for those.
 *
 * ⚠ NO OVERFLOW MENU. Download recording, copy transcript link and export summary are all
 * struck (D-B), and there is no support destination anywhere in `apps/web/src/app`, so every
 * item is dead. An empty or single-dead-item menu is worse than no button.
 */
export function RecapHeader({
  header,
  money,
}: Readonly<{ header: RecapHeaderView; money: RecapMoneyView | null }>): React.JSX.Element {
  return (
    <header className="flex flex-col gap-3">
      {header.caseHref !== null && (
        <Link
          href={header.caseHref}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1 inline-flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back to the case
        </Link>
      )}
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {header.eyebrow}
      </p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* BAL-499 F5: h2 — the chrome's Breadcrumbs `<h1>` (breadcrumbs.tsx) already carries
            this same title; keeping this at h1 would duplicate it for a screen-reader user
            navigating by heading. className unchanged, so nothing moves visually. */}
        <h2 className="text-foreground line-clamp-2 text-xl leading-snug font-semibold">
          {header.title}
        </h2>
        <RecapStatusChip status={header.status} />
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays size={14} aria-hidden="true" />
          <LocalDateTime iso={header.occurredAtIso} />
        </span>

        {header.durationMinutes !== null && (
          <>
            <Separator />
            <span className="inline-flex items-center gap-1.5">
              <Timer size={14} aria-hidden="true" />
              {header.durationMinutes} min
            </span>
          </>
        )}

        {money !== null && (
          <>
            <Separator />
            <MoneyLine money={money} />
          </>
        )}

        {header.totalActionItemCount > 0 && (
          <>
            <Separator />
            <ActionItemCount
              open={header.openActionItemCount}
              total={header.totalActionItemCount}
            />
          </>
        )}
      </div>

      {header.closedNote !== null && <InfoNote icon={CircleCheck}>{header.closedNote}</InfoNote>}
    </header>
  );
}

/** A muted dot between meta items. */
function Separator(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="text-muted-foreground/50">
      ·
    </span>
  );
}

/**
 * §R3 — RULE M, at the render.
 *
 * ⚠ ONE MUTED LINE FOR THE ABSENT BRANCH, AND IT IS KEYED ON ABSENCE OF A RECORD, NEVER ON A
 * BILLING RULE. "You were not charged" is a claim BAL-412 can falsify; "no consultation
 * charge for this one" cannot. When BAL-412 makes a no-show billable, a `credit_sessions` row
 * appears, this branch simply stops matching, and NO COPY CHANGES.
 *
 * ⚠ NEVER AN ERROR OR A WARNING — it is a neutral fact, in the same muted meta voice.
 * ⚠ NEVER A SECOND ERROR STATE around the fragment: a failed fetch is the fragment's own
 * muted fallback.
 *
 * ⚠ F10, UX review round 1 — NO `whitespace-nowrap` WRAPPER HERE ANYMORE. It was sized for
 * the pre-BAL-412 content (a short "Charged A$150.00") and clipped/overflowed at 375px once
 * BAL-412 appended the duration line. `MoneyBlock` already returns a single root element and
 * now wraps its own content (`money-block.tsx`'s `MoneyBlockFinalized`), so no wrapper is
 * needed — the surrounding meta row (`flex flex-wrap`, above) governs reflow the same way it
 * does for every other item in the row.
 */
function MoneyLine({ money }: Readonly<{ money: RecapMoneyView }>): React.JSX.Element {
  if (money.kind === 'absent') {
    return <span className="text-muted-foreground">No consultation charge for this one.</span>;
  }
  return <MoneyBlock block={money.block} elapsedMinutes={money.elapsedMinutes} />;
}

/**
 * §R2 — open action items. Hierarchy through WEIGHT and COLOUR, not size. When everything is
 * done the line congratulates rather than counting down to zero.
 */
function ActionItemCount({
  open,
  total,
}: Readonly<{ open: number; total: number }>): React.JSX.Element {
  if (open === 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <CheckCircle2 size={14} className="text-success" aria-hidden="true" />
        All action items done
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <ListChecks size={14} aria-hidden="true" />
      <span className="text-foreground font-semibold">{open}</span>
      <span>of {total} action items open</span>
    </span>
  );
}
