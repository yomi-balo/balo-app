'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * BAL-551 — the Lookup search box. Debounced (`DEBOUNCE_MS`, matching the
 * `use-project-draft.ts:40` single-consumer naming convention — there is no shared debounce
 * hook in this codebase) `router.replace` of `?q=`, so the query is shareable and the server
 * read re-runs on the App Router's own data flow rather than a client fetch. `isPending` is
 * lifted to the shell via `onPendingChange` so the results list can render its busy state.
 */

const DEBOUNCE_MS = 300;

interface LookupSearchBoxProps {
  readonly initialQuery: string;
  readonly onPendingChange: (pending: boolean) => void;
}

export function LookupSearchBox({
  initialQuery,
  onPendingChange,
}: Readonly<LookupSearchBoxProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initialQuery);
  const lastPushedRef = useRef(initialQuery);

  // The URL changed from OUTSIDE this box (back/forward navigation, a pasted link) — sync the
  // input without re-triggering the debounce.
  //
  // ⚠ BAL-551 fix round F3 — a re-render can also arrive as OUR OWN echo: the debounce timer
  // pushes `?q=north`, the server round-trips and re-renders with `initialQuery="north"`, but
  // by then the visitor may already have kept typing (`value` is `"northwind"` locally). That
  // echo is not an outside change — `lastPushedRef.current` already equals it — so it must be
  // a no-op rather than reverting `value` and clobbering the keystrokes typed in between.
  useEffect(() => {
    if (initialQuery === lastPushedRef.current) return;
    setValue(initialQuery);
    lastPushedRef.current = initialQuery;
  }, [initialQuery]);

  useEffect(() => {
    if (value === lastPushedRef.current) return;
    const timeout = setTimeout(() => {
      lastPushedRef.current = value;
      startTransition(() => {
        const trimmed = value.trim();
        const url =
          trimmed === '' ? '/admin/lookup' : `/admin/lookup?q=${encodeURIComponent(value)}`;
        router.replace(url, { scroll: false });
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [value, router]);

  useEffect(() => {
    onPendingChange(isPending);
  }, [isPending, onPendingChange]);

  return (
    <div className="relative">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="text"
        aria-label="Search Lookup"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Name, email, company, session id, PaymentIntent…"
        className={cn(
          'border-border bg-card text-foreground placeholder:text-muted-foreground w-full min-w-0',
          'focus-visible:ring-ring min-h-[44px] rounded-xl border py-2.5 pr-4 pl-10 text-sm',
          'focus-visible:ring-2 focus-visible:outline-none'
        )}
      />
      <p className="text-muted-foreground mt-1.5 ml-0.5 text-[11.5px]">
        {/* pending-MJ */}
        Ids work too — paste a session id or a Stripe PaymentIntent straight in.
      </p>
    </div>
  );
}
