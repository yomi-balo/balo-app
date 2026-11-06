'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  EXPERT_PROFILE_ROW,
  ExpertProfileAvatarLink,
  ExpertProfileLink,
} from '@/components/balo/expert-profile-link';
import { InlineRating } from '@/components/balo/rating-display';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { cn } from '@/lib/utils';
import type { RecapLens, RecapPartyView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R8 — the OTHER-PARTY card. Renders in EVERY cell of the matrix, including not-held,
 * because it is where the page's forward motion lives.
 *
 * ⚠ THE STAR RATING NOW RENDERS ALONGSIDE THE ORDINAL LINE (BAL-422 landed). The ordinal line
 * was never a placeholder for it — it is independently relevant and STAYS. The rating slotted
 * in exactly as this docblock promised: one more null-gated line in the same stack, no
 * structural change, nothing faked.
 *
 * ⚠ THE RATING IS CLIENT-LENS ONLY, and that is enforced by the SERVER, not by a branch here:
 * `resolve-counterparty.ts` hardcodes `ratingAverage: null` on the expert lens. `null` also
 * means an unrated expert. Either way the line does not render — and NEVER coalesce to `0`,
 * because 0.0 is unrepresentable on a 1..5 scale and would be a fabricated rating.
 *
 * ⚠ THIS CARD'S RESOLVER IS SHARED WITH THE END-OF-CALL LOADER, but that loader reads only the
 * counterparty LABELS and never `party`, so this card — and therefore the rating — does NOT
 * render on the end-of-call screen. No gate was added here on purpose: if that screen ever
 * adopts this card it inherits the same client-lens rating unchanged.
 *
 * ⚠⚠ NO EMAIL ADDRESS ANYWHERE. Not in the card, not in a `mailto:`, not in a `title`, and not
 * via a gravatar-style hash of one (ADR-1044). The avatar is `users.avatar_url` or initials.
 *
 * ⚠ ONLY LIVE DESTINATIONS RENDER, NEVER A DISABLED CTA. `/experts/{username}` is the ONE CTA
 * with a real route today — and `profileHref` is non-null only when that public profile
 * resolves, so a null means NO button (and an unlinked name) rather than a link that 404s.
 * Turn into project, send proposal, add a private note and offer a new time all have no
 * destination and are simply absent. The card reads complete with one action or with none.
 *
 * ⚠ NOTHING EVALUATIVE ON THE EXPERT LENS. The expert is not scoring the client: no rating,
 * no score, no history judgement.
 */
export function PartyCard({
  party,
  lens,
}: Readonly<{ party: RecapPartyView; lens: RecapLens }>): React.JSX.Element {
  const onBookAgain = useCallback(() => {
    track(RECAP_EVENTS.CTA_CLICKED, { cta: 'book_again', lens });
  }, [lens]);

  return (
    <section className="bg-card border-border rounded-2xl border p-6">
      <div className={cn('flex items-start gap-3', EXPERT_PROFILE_ROW)}>
        <ExpertProfileAvatarLink href={party.profileHref} surface="recap_party_card">
          <PartyAvatar avatarUrl={party.avatarUrl} initials={party.initials} />
        </ExpertProfileAvatarLink>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">
            <ExpertProfileLink href={party.profileHref} surface="recap_party_card">
              {party.name}
            </ExpertProfileLink>
          </p>
          {party.headline !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{party.headline}</p>
          )}
          {party.orgLabel !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs">{party.orgLabel}</p>
          )}
          {party.ratingAverage !== null && (
            <p className="text-muted-foreground mt-0.5 inline-flex items-center gap-1 text-xs">
              <InlineRating average={party.ratingAverage} count={party.ratingCount} />
            </p>
          )}
        </div>
      </div>

      {party.ordinalLine !== null && (
        <p className="border-border text-muted-foreground mt-4 border-t pt-3 text-xs">
          {party.ordinalLine}
        </p>
      )}

      {party.profileHref !== null && (
        <div className="mt-4 flex flex-col gap-2">
          <Button asChild variant="outline" className="min-h-11 w-full gap-2">
            <Link href={party.profileHref} onClick={onBookAgain}>
              <CalendarDays className="h-4 w-4" aria-hidden="true" />
              Book again
            </Link>
          </Button>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ShieldCheck size={12} aria-hidden="true" />
            Rebooking stays on Balo
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * `users.avatar_url` with an initials fallback.
 *
 * ⚠ NEVER DERIVED FROM AN EMAIL ADDRESS. A gravatar-style hashed-email URL would leak the
 * counterparty's address into the markup just as surely as printing it (ADR-1044).
 *
 * Uses the SHIPPED radix `Avatar` rather than a bare img element: the fallback paints only
 * once the image genuinely fails, and it satisfies `@next/next/no-img-element` without
 * needing an `Image` loader configured for arbitrary remote hosts.
 *
 * ⚠⚠ `users.avatar_url` IS NOT ALWAYS A URL, WHICH IS WHY `getAvatarUrl` IS NOT OPTIONAL.
 * A Balo upload stores an R2 KEY (`avatars/<uuid>/<uuid>.webp`); handing that straight to `src`
 * renders a relative path that 404s and silently falls back to initials, so ONLY WorkOS OAuth
 * avatars would ever paint. Every other display site in the app converts (`(dashboard)/layout`,
 * `expert-card`, `photo-upload`), and `getAvatarUrl` passes an `http` URL through untouched.
 */
function PartyAvatar({
  avatarUrl,
  initials,
}: Readonly<{ avatarUrl: string | null; initials: string }>): React.JSX.Element {
  const src = getAvatarUrl(avatarUrl, 'thumbnail');
  return (
    <Avatar size="lg" className="flex-none">
      {src !== null && <AvatarImage src={src} alt="" />}
      <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
