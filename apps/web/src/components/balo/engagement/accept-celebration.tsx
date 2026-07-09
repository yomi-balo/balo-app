'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';

/** The sessionStorage key that arms the completed-banner celebration for one refresh. */
export function celebrationStorageKey(engagementId: string): string {
  return `balo:engagement-celebrate:${engagementId}`;
}

const CONFETTI_COLORS = ['#2563EB', '#7C3AED', '#059669', '#D97706'] as const;
const PARTICLE_COUNT = 26;
const CELEBRATION_MS = 2600;

/**
 * The one-shot completed-banner celebration overlay (BAL-338 / D7). Fires ONLY on the
 * in-session accept transition: the client accept flow writes a sessionStorage flag
 * BEFORE the RSC refresh, and on mount this reads + CLEARS the flag — so a later
 * revisit/reload (flag absent) renders the calm banner, never replaying. Honors
 * reduced-motion (renders nothing). Absolutely positioned — the parent banner must be
 * `relative overflow-hidden`.
 */
export function AcceptCelebration({
  engagementId,
}: Readonly<{ engagementId: string }>): React.JSX.Element | null {
  const reduceMotion = useReducedMotion();
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    if (reduceMotion || typeof window === 'undefined') return;
    let armed = false;
    try {
      const key = celebrationStorageKey(engagementId);
      armed = window.sessionStorage.getItem(key) === '1';
      if (armed) window.sessionStorage.removeItem(key);
    } catch {
      armed = false; // sessionStorage can throw (private mode) — degrade to no confetti.
    }
    if (!armed) return;
    setCelebrate(true);
    const timer = window.setTimeout(() => setCelebrate(false), CELEBRATION_MS);
    return () => window.clearTimeout(timer);
  }, [engagementId, reduceMotion]);

  if (!celebrate) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
      aria-hidden="true"
    >
      {Array.from({ length: PARTICLE_COUNT }).map((_, i) => {
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0];
        return (
          <span
            key={i}
            className="absolute top-0"
            style={{
              left: `${(i * 137) % 100}%`,
              width: i % 3 === 0 ? 8 : 6,
              height: i % 2 === 0 ? 10 : 6,
              borderRadius: i % 3 === 0 ? '50%' : 2,
              backgroundColor: color,
              animation: `confettiFall ${1.4 + (i % 5) * 0.22}s ease-in ${(i % 7) * 0.09}s both`,
            }}
          />
        );
      })}
    </div>
  );
}
