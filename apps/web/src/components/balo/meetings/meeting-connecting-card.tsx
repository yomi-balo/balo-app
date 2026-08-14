'use client';

import { Loader2 } from 'lucide-react';

/**
 * BAL-132's shipped "Connecting…" card, EXTRACTED VERBATIM so BAL-435 can reuse it as the
 * `dynamic()` loading fallback without duplicating the markup.
 *
 * ⚠⚠ **NO `aria-busy` ANYWHERE IN THIS SUBTREE, INCLUDING THE DECORATIVE SPAN.** It tells
 * assistive tech to SUPPRESS announcements from the region it is on and, in several screen
 * readers, from that region's descendants — and on a live region whose entire job is to say
 * "you're in", that silences the one message the element exists to deliver.
 *
 * An earlier fix moved the attribute from the `<output>` onto the decorative `<span>` while the
 * docblock above it announced "NO `aria-busy`" three lines before shipping `aria-busy="true"`.
 * That is worse than either choice made honestly: the attribute was still inside the live region,
 * it still never cleared, and its only child is already `aria-hidden`, so it described nothing to
 * anyone. It is GONE, and this paragraph is what stops it coming back "on the decorative element,
 * where it's safe".
 *
 * ⚠ `<output>`, NOT `role="status"` — SonarCloud S6819 flags the ARIA role where a native element
 * exists.
 */
export function MeetingConnectingCard({
  headingRef,
}: Readonly<{ headingRef?: React.Ref<HTMLHeadingElement> }>): React.JSX.Element {
  return (
    <output className="border-border bg-card mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden="true" />
      </span>
      {/* ⚠ `tabIndex={-1}` — programmatically focusable, never in the tab order. */}
      <h1 ref={headingRef} tabIndex={-1} className="text-foreground mt-4 text-lg font-semibold">
        Connecting…
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        You&apos;re in. We&apos;re setting up your call room now.
      </p>
    </output>
  );
}
