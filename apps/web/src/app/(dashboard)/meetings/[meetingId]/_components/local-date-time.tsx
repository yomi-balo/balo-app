'use client';

import { useEffect, useState } from 'react';

/**
 * BAL-388 §R2 — an ABSOLUTE date/time, in the VIEWER's timezone. A recap is a record, so it
 * never says "2 hours ago".
 *
 * ⚠ THE ZONE IS ANNOUNCED, NOT ONLY HOVERED. A `title` reaches a mouse and nothing else,
 * so the resolved zone is also rendered as an `sr-only` span — on a page whose whole job is to
 * be an authoritative record, a keyboard or screen-reader user must be able to tell WHICH
 * clock the timestamp is in.
 *
 * ⚠ THE SERVER RENDER IS UTC AND THE CLIENT UPGRADES IT AFTER MOUNT. Formatting with the
 * browser timezone during the first render would produce server/client HTML that differs for
 * every viewer outside UTC — a hydration mismatch on every page load. The initial state is
 * therefore the SAME string the server produced, and `useEffect` swaps in the local one.
 */
export function LocalDateTime({ iso }: Readonly<{ iso: string }>): React.JSX.Element {
  const [label, setLabel] = useState(() => formatIn(iso, 'UTC'));
  const [zone, setZone] = useState('UTC');

  useEffect(() => {
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (viewerZone) {
      setZone(viewerZone);
      setLabel(formatIn(iso, viewerZone));
    }
  }, [iso]);

  return (
    <time dateTime={iso} title={label + ' (' + zone + ')'}>
      {label}
      <span className="sr-only"> ({zone})</span>
    </time>
  );
}

/** "Tue 29 Jul 2026, 2:14 pm" in the given IANA zone. */
function formatIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
