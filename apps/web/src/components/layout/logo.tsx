import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * The Balo brand marks, served from `public/brand/`.
 *
 * Each mark ships a LIGHT (navy `#220066` letterforms) and a DARK (white letterforms) variant.
 * Both variants of a mark are generated from the SAME source artwork — only the letterform
 * colour is remapped, the cyan `#38B6FF` arcs are untouched — so the two are pixel-identical in
 * geometry. That matters: the supplied stand-alone white wordmark had different framing
 * (content ratio 2.208 vs 2.086) and swapping to it would have visibly resized the logo on a
 * theme toggle.
 *
 * The PNGs are trimmed to their alpha bounding box, so the rendered box IS the glyph and all
 * padding is controlled here in CSS rather than baked into the asset.
 */
const MARKS = {
  wordmark: {
    light: '/brand/balo-wordmark.png',
    dark: '/brand/balo-wordmark-dark.png',
    ratio: 776 / 372,
  },
  icon: {
    light: '/brand/balo-icon.png',
    dark: '/brand/balo-icon-dark.png',
    ratio: 316 / 464,
  },
} as const;

interface LogoProps {
  className?: string;
  /** Render the single-letter icon instead of the full wordmark (the collapsed sidebar rail). */
  iconOnly?: boolean;
  /** Render as a plain element rather than a link home — for surfaces that ARE the destination
   *  (the auth and onboarding screens), where a link back to marketing is a dead end. */
  asLink?: boolean;
  /** Rendered height of the mark in CSS px. Width is derived from the mark's intrinsic ratio,
   *  which is what keeps `next/image` emitting a correctly-sized srcset instead of the full
   *  776px asset for a 28px logo. */
  height?: number;
  /** Which colour variant to paint. `'auto'` (the default) follows the app theme. Pin it to
   *  `'dark'` for a surface that is dark in BOTH themes — a gradient header, say — where the
   *  theme-following navy mark would otherwise vanish in light mode. */
  variant?: 'auto' | 'light' | 'dark';
}

export function Logo({
  className,
  iconOnly = false,
  asLink = true,
  height = 28,
  variant = 'auto',
}: Readonly<LogoProps>): React.JSX.Element {
  const mark = iconOnly ? MARKS.icon : MARKS.wordmark;
  const width = Math.round(height * mark.ratio);

  // Both variants are always in the DOM and the theme picks one with `display:none`. That keeps
  // the swap pure CSS — no `useTheme()` read, so no hydration mismatch and no flash of the wrong
  // mark on first paint or on toggle.
  //
  // Both images are decorative (`alt=""`) and the WRAPPER carries the single accessible name.
  // Giving each image `alt="Balo"` would be correct in a browser (the hidden one leaves the a11y
  // tree) but wrong under jsdom, where no CSS applies and BOTH would be exposed — so
  // `getByAltText('Balo')` would throw on multiple matches. One name on the wrapper is true in
  // both environments.
  const marks =
    variant === 'auto' ? (
      <>
        <Image
          src={mark.light}
          alt=""
          width={width}
          height={height}
          priority
          className="dark:hidden"
        />
        <Image
          src={mark.dark}
          alt=""
          width={width}
          height={height}
          priority
          className="hidden dark:block"
        />
      </>
    ) : (
      <Image
        src={variant === 'dark' ? mark.dark : mark.light}
        alt=""
        width={width}
        height={height}
        priority
      />
    );

  if (!asLink) {
    return (
      <span role="img" aria-label="Balo" className={cn('inline-flex items-center', className)}>
        {marks}
      </span>
    );
  }

  return (
    <Link
      href="/"
      aria-label="Balo"
      className={cn(
        'inline-flex items-center rounded-lg transition-opacity hover:opacity-80 motion-reduce:transition-none',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className
      )}
    >
      {marks}
    </Link>
  );
}
