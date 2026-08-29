'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { InfoNote } from '@/components/balo/section/section-states';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { cn } from '@/lib/utils';
import type { CaseHeaderView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — the case header: title, status chip, meta line, the clamped description, and the
 * closed-case note.
 *
 * ⚠ THE DESCRIPTION IS CLAMPED WITH AN EXPAND AFFORDANCE (an explicit AC), and the toggle is
 * a real `<button>` with `aria-expanded` + `aria-controls` — not a bare div — so a keyboard
 * user can reach it and a screen reader is told what it does.
 *
 * ⚠⚠ THE TOGGLE RENDERS ONLY WHEN THE TEXT ACTUALLY OVERFLOWS ITS CLAMP, MEASURED AFTER MOUNT.
 * `line-clamp-3` is CSS: whether it truncates depends on the rendered text and the container's
 * width, neither of which is knowable server-side. Rendering the button unconditionally gave a
 * one-line description a control that expanded nothing, and `aria-expanded` then announced a
 * disclosure with NO hidden content — a lie to a screen reader, not merely a stray pixel. So
 * the measurement is a real one (`scrollHeight > clientHeight` on the clamped node) and it is
 * re-run on resize, because a viewport change can move a description across the boundary in
 * either direction.
 *
 * ⚠ MEASURE ONLY WHILE COLLAPSED. Once expanded the clamp is gone and `scrollHeight ===
 * clientHeight`, so a measurement taken then would report "no overflow" and REMOVE THE VERY
 * BUTTON THE USER JUST PRESSED — stranding them expanded with no way back. The effect
 * early-returns while expanded and the last collapsed verdict is what persists.
 *
 * ⚠ `prose` IS A NO-OP IN THIS APP. There is no `@tailwindcss/typography` plugin (memory
 * `reference_no_tailwind_typography_plugin`), so the sanitised markup is styled EXPLICITLY via
 * the `[&_p]:` / `[&_a]:` arbitrary variants below. Reaching for `prose` here would silently
 * render unstyled HTML.
 *
 * ⚠⚠ `descriptionHtml` IS SANITISED AT **READ**, IN `load-case.ts`, AND THAT IS THE ONLY
 * THING MAKING `dangerouslySetInnerHTML` SAFE HERE. Do NOT restate this as "sanitised at the
 * write boundary" — `case_engagements.description` has NO enforced write-side sanitisation.
 * The schema says so outright (`schema/case-engagements.ts:60-72`: the FIRST writer must
 * sanitise, and storing raw client HTML is a stored-XSS vector), and today every writer is a
 * hardcoded literal, so no such writer exists yet. This component is `'use client'` and
 * therefore structurally CANNOT sanitise, which is why the guard lives in the server loader.
 * If that call is ever removed, this line becomes stored XSS the moment BAL-400 lets a client
 * type a description.
 */
export function CaseHeader({ header }: Readonly<{ header: CaseHeaderView }>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const descriptionId = useId();

  const toggle = useCallback(() => {
    setExpanded((previous) => !previous);
  }, []);

  useEffect(() => {
    // See the docblock: never measure while expanded — the clamp is gone and every
    // description would report "fits", removing the button the reader is currently using.
    if (expanded) return;

    const node = descriptionRef.current;
    if (node === null) return;

    const measure = (): void => {
      const element = descriptionRef.current;
      if (element === null) return;
      // 1px of tolerance: sub-pixel line-height rounding makes an exactly-fitting block
      // report a `scrollHeight` a hair over its `clientHeight` in some engines.
      setOverflowing(element.scrollHeight - element.clientHeight > 1);
    };
    measure();

    // JSDOM and older engines lack ResizeObserver; the initial measurement above still
    // stands, so the affordance degrades to "correct at mount" rather than disappearing.
    if (typeof globalThis.ResizeObserver !== 'function') return;
    const observer = new globalThis.ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [expanded, header.descriptionHtml]);

  return (
    <header className="bg-card border-border rounded-3xl border px-6 py-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* BAL-499 F5: h2 — the chrome's Breadcrumbs `<h1>` (breadcrumbs.tsx) already carries
              this same title; keeping this at h1 would duplicate it for a screen-reader user
              navigating by heading. className unchanged, so nothing moves visually. */}
          <h2 className="text-foreground text-xl leading-snug font-semibold">{header.title}</h2>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
            <span>
              Opened <LocalDateTime iso={header.openedAtIso} variant="day-month" />
            </span>
            <Dot />
            <span>
              {header.heldConsultationCount} consultation
              {header.heldConsultationCount === 1 ? '' : 's'} held
            </span>
            <Dot />
            <span className="truncate">{header.counterpartyOrgLabel}</span>
          </div>
        </div>
        <StatusChip isOpen={header.isOpen} closeReason={header.closeReason} />
      </div>

      <div className="mt-3 max-w-2xl">
        <div
          id={descriptionId}
          ref={descriptionRef}
          className={cn(
            'text-muted-foreground text-sm leading-relaxed',
            // Explicit markup styling — `prose` does nothing in this app. See the docblock.
            '[&_a]:text-primary [&_a]:underline [&_p]:mb-2 [&_p:last-child]:mb-0',
            '[&_li]:mb-1 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5',
            '[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5',
            expanded ? undefined : 'line-clamp-3'
          )}
          // `descriptionHtml` is sanitised by `sanitizeProjectHtml` in `load-case.ts` — at
          // READ, on the server, because this is a client component and the column has no
          // enforced write-side sanitisation. Never render `caseRow.description` directly.
          dangerouslySetInnerHTML={{ __html: header.descriptionHtml }}
        />
        {overflowing && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={descriptionId}
            className="text-primary focus-visible:ring-ring mt-1.5 rounded text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>

      {header.closedNote !== null && (
        <div className="mt-4">
          <InfoNote icon={CircleCheck}>{header.closedNote}</InfoNote>
        </div>
      )}
    </header>
  );
}

function Dot(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="text-muted-foreground/50">
      ·
    </span>
  );
}

/**
 * `Open` / `Resolved` / `Closed — inactive`, verbatim from the design reference.
 *
 * ⚠ THE TWO CLOSED REASONS STAY DISTINCT. "Resolved" is something the client DID; "Closed —
 * inactive" is something that HAPPENED because nobody acted. Collapsing them into one
 * "Closed" chip would tell a client their case was resolved when in fact it timed out.
 */
function StatusChip({
  isOpen,
  closeReason,
}: Readonly<{ isOpen: boolean; closeReason: CaseHeaderView['closeReason'] }>): React.JSX.Element {
  if (isOpen) {
    return (
      <span className="bg-success/10 text-success shrink-0 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap">
        Open
      </span>
    );
  }
  return (
    <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap">
      {closeReason === 'auto_inactive' ? 'Closed — inactive' : 'Resolved'}
    </span>
  );
}
