import { cn } from '@/lib/utils';

/**
 * Intent-step artwork, drawn from the design reference
 * (`.claude/design-references/Balo Onboarding — What brings you to Balo.html`).
 *
 * Every colour is a theme token applied through `fill-*` / `stroke-*` classes — SVG
 * presentation attributes cannot resolve `var(--token)`, so the classes are what let the
 * artwork follow dark mode. `stroke-(--tint)` is the opaque panel colour the parent choice
 * card defines, so a badge ring reads as a cut-out against the panel behind it.
 */

interface IllustrationProps {
  className?: string;
}

/** The five-point star inside the expert badge (centred on the origin, radius 7). */
const STAR_POINTS =
  '0,-7 1.76,-2.43 6.66,-2.16 2.85,0.93 4.11,5.66 0,3 -4.11,5.66 -2.85,0.93 -6.66,-2.16 -1.76,-2.43';

/** Desktop panel art for "Find an Expert": a verified expert card flanked by two more. */
export function FindExpertIllustration({
  className,
}: Readonly<IllustrationProps>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 396 200"
      fill="none"
      aria-hidden="true"
      className={cn('h-full w-full max-w-[396px]', className)}
    >
      <g opacity={0.75}>
        <rect
          x={40}
          y={56}
          width={124}
          height={116}
          rx={14}
          className="fill-card stroke-primary/15"
        />
        <circle cx={102} cy={92} r={17} className="fill-primary/15" />
        <rect x={72} y={122} width={60} height={7} rx={3.5} className="fill-muted-foreground/35" />
        <rect x={82} y={137} width={40} height={6} rx={3} className="fill-muted-foreground/15" />
        <rect
          x={232}
          y={56}
          width={124}
          height={116}
          rx={14}
          className="fill-card stroke-primary/15"
        />
        <circle cx={294} cy={92} r={17} className="fill-primary/15" />
        <rect x={264} y={122} width={60} height={7} rx={3.5} className="fill-muted-foreground/35" />
        <rect x={274} y={137} width={40} height={6} rx={3} className="fill-muted-foreground/15" />
      </g>
      <rect
        x={126}
        y={36}
        width={144}
        height={146}
        rx={18}
        opacity={0.1}
        className="fill-primary"
      />
      <rect
        x={126}
        y={28}
        width={144}
        height={146}
        rx={18}
        className="fill-card stroke-primary/25"
      />
      <circle cx={198} cy={72} r={24} className="fill-primary/12" />
      <circle cx={198} cy={66} r={8.5} className="fill-primary" />
      <path
        d="M182.5 90.5c1.8-7.6 8-12 15.5-12s13.7 4.4 15.5 12a24 24 0 0 1-31 0z"
        className="fill-primary"
      />
      <rect
        x={164}
        y={108}
        width={68}
        height={8}
        rx={4}
        opacity={0.85}
        className="fill-foreground"
      />
      <rect x={176} y={124} width={44} height={6} rx={3} className="fill-muted-foreground/30" />
      <rect x={146} y={144} width={48} height={14} rx={7} className="fill-primary/7" />
      <rect x={200} y={144} width={50} height={14} rx={7} className="fill-primary/7" />
      <circle cx={262} cy={38} r={15} strokeWidth={3.5} className="fill-primary stroke-card" />
      <path
        d="M255.5 38.5l4.5 4.5 8.5-9"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary-foreground"
      />
    </svg>
  );
}

/** Desktop panel art for "Become an Expert": a profile beside a rising earnings curve. */
export function BecomeExpertIllustration({
  className,
}: Readonly<IllustrationProps>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 396 200"
      fill="none"
      aria-hidden="true"
      className={cn('h-full w-full max-w-[396px]', className)}
    >
      <rect x={44} y={40} width={308} height={136} rx={18} opacity={0.1} className="fill-violet" />
      <rect x={44} y={32} width={308} height={136} rx={18} className="fill-card stroke-violet/25" />
      <circle cx={84} cy={70} r={18} className="fill-violet/14" />
      <circle cx={84} cy={65.5} r={6.5} className="fill-violet" />
      <path
        d="M72.5 84c1.4-5.8 6-9 11.5-9s10.1 3.2 11.5 9a18 18 0 0 1-23 0z"
        className="fill-violet"
      />
      <rect
        x={64}
        y={102}
        width={56}
        height={8}
        rx={4}
        opacity={0.85}
        className="fill-foreground"
      />
      <rect x={64} y={118} width={40} height={6} rx={3} className="fill-muted-foreground/30" />
      <rect x={64} y={136} width={46} height={14} rx={7} className="fill-violet/8" />
      <path d="M148 32v136" className="stroke-violet/12" />
      <path
        d="M168 68h164M168 100h164M168 132h164"
        strokeDasharray="3 5"
        className="stroke-violet/10"
      />
      <path d="M168 142c30-3 42-20 70-28s46-18 78-44v72z" opacity={0.08} className="fill-violet" />
      <path
        d="M168 142c30-3 42-20 70-28s46-18 78-44"
        strokeWidth={2.6}
        strokeLinecap="round"
        className="stroke-violet"
      />
      <circle cx={204} cy={134} r={4.5} strokeWidth={2.4} className="fill-card stroke-violet" />
      <circle cx={250} cy={110} r={4.5} strokeWidth={2.4} className="fill-card stroke-violet" />
      <circle cx={316} cy={70} r={15} strokeWidth={3.5} className="fill-violet stroke-card" />
      <polygon
        transform="translate(316 70.5)"
        points={STAR_POINTS}
        className="fill-primary-foreground"
      />
    </svg>
  );
}

/** Compact mobile tile icon for "Find an Expert". */
export function FindExpertIcon({ className }: Readonly<IllustrationProps>): React.JSX.Element {
  return (
    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true" className={cn('size-11', className)}>
      <circle cx={20} cy={20} r={16} className="fill-card stroke-primary/25" />
      <circle cx={20} cy={16.5} r={5} className="fill-primary" />
      <path
        d="M10.5 28.5c1.3-5 5-7.5 9.5-7.5s8.2 2.5 9.5 7.5a16 16 0 0 1-19 0z"
        className="fill-primary"
      />
      <circle cx={34} cy={34} r={8} strokeWidth={2.5} className="fill-primary stroke-(--tint)" />
      <path
        d="M30.5 34.2l2.4 2.4 4.6-4.8"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary-foreground"
      />
    </svg>
  );
}

/** Compact mobile tile icon for "Become an Expert". */
export function BecomeExpertIcon({ className }: Readonly<IllustrationProps>): React.JSX.Element {
  return (
    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true" className={cn('size-11', className)}>
      <path d="M4 36c8-1 11-7 17-10s10-6 15-13v23z" opacity={0.1} className="fill-violet" />
      <path
        d="M4 36c8-1 11-7 17-10s10-6 15-13"
        strokeWidth={2.4}
        strokeLinecap="round"
        className="stroke-violet"
      />
      <circle cx={21} cy={26} r={3} strokeWidth={2} className="fill-card stroke-violet" />
      <circle cx={35} cy={11} r={8} strokeWidth={2.5} className="fill-violet stroke-(--tint)" />
      <polygon
        transform="translate(35 11.3) scale(.6)"
        points={STAR_POINTS}
        className="fill-primary-foreground"
      />
    </svg>
  );
}
