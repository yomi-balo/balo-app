'use client';

import { useEffect, useState } from 'react';
import { formatLocalShortDate, formatUtcShortDate } from '@/lib/format/local-date';

interface LocalDateProps {
  /** ISO-8601 timestamp to render. */
  iso: string;
  className?: string;
}

/**
 * LocalDate — renders a short "12 Jun" date in the VIEWER's own timezone, for a
 * team spread across timezones (e.g. an auto-accept date signalling money about to
 * trigger reads correctly for each admin's local frame).
 *
 * SSR and the first client render use the UTC fallback — identical on both sides,
 * so hydration never mismatches — then `useEffect` swaps to the browser-local label
 * after mount. For most timestamps the two agree; only ones near midnight differ by
 * a day, and the correction is imperceptible.
 */
export function LocalDate({ iso, className }: Readonly<LocalDateProps>): React.JSX.Element {
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    setLocal(formatLocalShortDate(iso));
  }, [iso]);

  return (
    <time dateTime={iso} className={className}>
      {local ?? formatUtcShortDate(iso)}
    </time>
  );
}
