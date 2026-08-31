/**
 * BAL-510 — inline SVG icons for the /v2 preview, ported verbatim from the design ref
 * (ref :566-637; Lucide-style paths, stroke 2, round caps).
 *
 * Deliberately NOT `lucide-react` (repo convention elsewhere): Lucide's current path
 * data differs subtly from the ref's hand-written paths (e.g. `search` is
 * `m21 21-4.34-4.34` upstream vs. the ref's `M21 21l-4.35-4.35`), and Lucide doesn't set
 * `aria-hidden` by default. On a page whose entire purpose is pixel comparison against
 * the ref, a self-contained icon module that deletes with the folder is the correct
 * trade — recorded as a deliberate deviation from the repo's Lucide convention.
 *
 * Presentational only — no client directive needed.
 */

interface SvgProps {
  size?: number;
  color?: string;
  className?: string;
  children: React.ReactNode;
}

function Svg({
  size = 16,
  color = 'currentColor',
  className,
  children,
}: Readonly<SvgProps>): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export type IconProps = Readonly<Omit<SvgProps, 'children'>>;

export const I = {
  arrow: (p: IconProps): React.JSX.Element => (
    <Svg {...p} className="mk2-arrow">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  arrowPlain: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  check: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  video: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  menu: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </Svg>
  ),
  x: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  ),
  search: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  ),
  box: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </Svg>
  ),
  chev: (p: IconProps): React.JSX.Element => (
    <Svg {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  ),
};
