import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ExpertProfileLinkProps {
  /**
   * The expert's public profile path (`/experts/{username}`), or `null` when that profile does
   * not resolve for this viewer. The caller passes only a value the server already gated on the
   * public-profile rule, so a non-null href never lands on a 404.
   */
  href: string | null;
  /** The expert's name, and nothing else: it is the link's whole accessible name. */
  children: ReactNode;
  /**
   * Optional avatar. Present → the avatar and the name render as ONE link (one tab stop), with
   * the avatar wrapped `aria-hidden` so its initials never join the accessible name. Absent →
   * an inline text link that sits inside a sentence-like line.
   *
   * ⚠ THE AVATAR IS ABSOLUTELY POSITIONED against the nearest positioned ancestor, which the
   * caller provides: a `relative` identity column whose left padding is the avatar width plus
   * the gap and whose minimum height is the avatar's. The name and every detail line under it
   * (headline, rating, next call) then stack in that column beside the avatar, exactly as the
   * design references' `flex gap-3` identity block lays them out, while the link holds only
   * the avatar and the name.
   */
  avatar?: ReactNode;
  /**
   * Where the avatar sits against the identity column: `start` (top-aligned, the
   * `items-start` cards) or `center` (vertically centred, the `items-center` headers; the
   * caller centres the column's own content too).
   */
  avatarAlign?: 'start' | 'center';
  /**
   * Merged onto the link (inline) or onto the name block (both with and without an href). An
   * inline name with a null href renders bare, so this class is not applied there.
   */
  className?: string;
}

const FOCUS_RING = 'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

const INLINE_LINK_CLASS = cn('rounded-sm underline-offset-2 hover:underline', FOCUS_RING);

/** Sized to the name, never wider than the column, so a long name can still truncate. */
const NAME_BLOCK_CLASS = 'block w-fit max-w-full min-w-0';

const AVATAR_POSITION = {
  start: 'top-0',
  center: 'top-1/2 -translate-y-1/2',
} as const;

/**
 * The expert's name (optionally with their avatar) as a link to their public profile.
 *
 * With an href it renders a `next/link`; with `null` it renders the same content unlinked —
 * never a dead `#` link or a disabled one. The text colour is inherited from the surrounding
 * line; the affordance is a hover underline and a focus ring, both of which draw outside the
 * box, so linking a name causes no layout shift. The avatar variant renders the same boxes
 * with and without an href, so the unlinked (expert lens) layout matches the linked one.
 */
export function ExpertProfileLink({
  href,
  children,
  avatar,
  avatarAlign = 'start',
  className,
}: Readonly<ExpertProfileLinkProps>): React.JSX.Element {
  if (avatar === undefined) {
    if (href === null) return <>{children}</>;
    return (
      <Link href={href} className={cn(INLINE_LINK_CLASS, className)}>
        {children}
      </Link>
    );
  }

  const content = (
    <>
      <span aria-hidden="true" className={cn('absolute left-0 flex', AVATAR_POSITION[avatarAlign])}>
        {avatar}
      </span>
      <span
        className={cn(
          'block min-w-0',
          href !== null && 'underline-offset-2 group-hover/expert-profile-link:underline'
        )}
      >
        {children}
      </span>
    </>
  );

  if (href === null) return <span className={cn(NAME_BLOCK_CLASS, className)}>{content}</span>;
  return (
    <Link
      href={href}
      className={cn(
        'group/expert-profile-link rounded-sm',
        NAME_BLOCK_CLASS,
        FOCUS_RING,
        className
      )}
    >
      {content}
    </Link>
  );
}
