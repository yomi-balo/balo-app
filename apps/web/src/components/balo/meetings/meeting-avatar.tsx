'use client';

/**
 * BAL-435 — the camera-off / waiting avatar: deterministic initials on a deterministic hue.
 *
 * ⚠ NO `@daily-co` IMPORT IN THIS FILE. `WaitingStage` uses it, and keeping it vendor-free means
 * the waiting-state tests need no SDK mock at all.
 *
 * ⚠ THE HUE IS DERIVED FROM THE NAME, so the same person is the same colour on every tile and
 * across reloads — without storing anything.
 */

/** ⚠ NOT a hardcoded palette: an `hsl()` on a fixed saturation/lightness stays legible on dark. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (first === undefined) return '?';
  const a = first.charAt(0);
  const b = second?.charAt(0) ?? '';
  return `${a}${b}`.toUpperCase();
}

export function MeetingAvatar({
  name,
  size = 48,
}: Readonly<{ name: string; size?: number }>): React.JSX.Element {
  const hue = hueFor(name);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      // ⚠ INLINE ONLY FOR THE COMPUTED HUE AND SIZE — every other colour on this surface is a
      // token. A per-person hue cannot be a Tailwind class.
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        backgroundColor: `hsl(${hue} 55% 45%)`,
      }}
      aria-hidden="true"
    >
      {initialsFor(name)}
    </span>
  );
}
