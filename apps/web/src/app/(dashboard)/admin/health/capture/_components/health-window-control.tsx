'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * BAL-550 (§7) — the date-range control. Client (needs `useRouter`), fully uncontrolled by the
 * server: `from`/`to` are the CURRENT values from the URL, and "Apply" pushes a new
 * `?from=&to=` (preserving `category`), letting `page.tsx` re-parse and re-load. `fellBack`
 * renders the note saying what was shown instead.
 *
 * ⚠ `page.tsx` KEYS THIS COMPONENT on the resolved window, so the two `useState` seeds below are
 * re-read whenever the server resolves a different one. Without that key an Apply that got
 * CLAMPED would leave the inputs showing the rejected range rather than the one actually used.
 */
interface HealthWindowControlProps {
  readonly fromIso: string;
  readonly toIso: string;
  /** The span actually resolved — what the fall-back note reports. */
  readonly days: number;
  readonly fellBack: boolean;
}

export function HealthWindowControl({
  fromIso,
  toIso,
  days,
  fellBack,
}: Readonly<HealthWindowControlProps>): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(fromIso);
  const [to, setTo] = useState(toIso);

  const handleApply = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', from);
    params.set('to', to);
    router.push(`?${params.toString()}`);
  }, [from, to, router, searchParams]);

  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <div className="flex flex-col gap-1">
        <Label htmlFor="capture-health-from" className="text-muted-foreground text-[11px]">
          From (UTC)
        </Label>
        <Input
          id="capture-health-from"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-8 w-[150px] text-[12.5px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="capture-health-to" className="text-muted-foreground text-[11px]">
          To (UTC)
        </Label>
        <Input
          id="capture-health-to"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-8 w-[150px] text-[12.5px]"
        />
      </div>
      <Button size="sm" variant="outline" onClick={handleApply}>
        Apply
      </Button>
      {fellBack && (
        <p className="text-warning basis-full text-[11.5px]">
          {/* ⚠ REPORTS THE RESOLVED WINDOW, NOT A FIXED "30 days". The two fall-back paths land
              in DIFFERENT places: an invalid or inverted range falls back to the default 30 days
              ending today, while an over-cap range is clamped to the maximum span ending at the
              date that was ASKED for. A hard-coded "last 30 days" is simply false for the
              second, and the range it names is the one the rows below actually came from. */}
          The requested range was invalid or too wide — showing {days} days ending {toIso} instead.
        </p>
      )}
    </div>
  );
}
