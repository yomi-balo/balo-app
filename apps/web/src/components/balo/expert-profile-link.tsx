'use client';

import Link from 'next/link';
import { useCallback, type ReactNode } from 'react';
import { track, EXPERT_PROFILE_EVENTS, type ExpertProfileLinkSurface } from '@/lib/analytics';
import { cn } from '@/lib/utils';

interface ExpertProfileLinkBaseProps {
  /**
   * The expert's public profile path (`/experts/{username}`), or `null` when that profile does
   * not resolve for this viewer. The caller passes only a value the server already gated on the
   * public-profile rule, so a non-null href never lands on a 404.
   */
  href: string | null;
  /** The page region the link sits in, reported on click. */
  surface: ExpertProfileLinkSurface;
  children: ReactNode;
}

interface ExpertProfileLinkProps extends ExpertProfileLinkBaseProps {
  /** Merged onto the link. A null href renders the children bare, so it is not applied there. */
  className?: string;
}

/**
 * Goes on the row that holds an `ExpertProfileAvatarLink` and its `ExpertProfileLink`, so
 * hovering the avatar underlines the name too.
 */
export const EXPERT_PROFILE_ROW = 'group/expert-profile';

/**
 * The name's own hover underline, plus the same underline while the row's avatar link is
 * hovered. Outside an `EXPERT_PROFILE_ROW` the second variant never matches.
 */
const NAME_LINK_CLASS = cn(
  'rounded-sm underline-offset-2 hover:underline',
  'group-has-[[data-expert-profile-avatar]:hover]/expert-profile:underline',
  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none'
);

function useTrackProfileLinkClick(surface: ExpertProfileLinkSurface): () => void {
  return useCallback(() => {
    track(EXPERT_PROFILE_EVENTS.PROFILE_LINK_CLICKED, { surface });
  }, [surface]);
}

/**
 * The expert's name as a link to their public profile.
 *
 * With an href it renders a `next/link`; with `null` it renders the children bare — never a
 * dead `#` link or a disabled one. The text colour is inherited from the surrounding line; the
 * affordance is a hover underline and a focus ring, neither of which takes layout space, so
 * linking a name causes no layout shift. The ring is drawn inset, inside the link's own box, so
 * a `truncate` ancestor's overflow clip cannot cut it off. The link's accessible name is its
 * children, so pass the person's name and nothing else.
 */
export function ExpertProfileLink({
  href,
  surface,
  children,
  className,
}: Readonly<ExpertProfileLinkProps>): React.JSX.Element {
  const onClick = useTrackProfileLinkClick(surface);
  if (href === null) return <>{children}</>;
  return (
    <Link href={href} onClick={onClick} className={cn(NAME_LINK_CLASS, className)}>
      {children}
    </Link>
  );
}

/**
 * The expert's avatar as a second, pointer-only way into the same profile as the name beside
 * it. It is out of the tab order and hidden from assistive tech, so the row stays one tab stop
 * and one link named by the person: the `ExpertProfileLink` on the name. It wraps the avatar
 * where the avatar already sits in the row, as a non-shrinking flex item, so it adds no
 * geometry of its own. With `null` it renders the avatar bare.
 */
export function ExpertProfileAvatarLink({
  href,
  surface,
  children,
}: Readonly<ExpertProfileLinkBaseProps>): React.JSX.Element {
  const onClick = useTrackProfileLinkClick(surface);
  if (href === null) return <>{children}</>;
  return (
    <Link
      href={href}
      onClick={onClick}
      tabIndex={-1}
      aria-hidden="true"
      data-expert-profile-avatar=""
      className="shrink-0"
    >
      {children}
    </Link>
  );
}
