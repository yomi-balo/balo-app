'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import type { RecapLens, RecapPartyView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R8 — the OTHER-PARTY card. Renders in EVERY cell of the matrix, including not-held,
 * because it is where the page's forward motion lives.
 *
 * ⚠ THE ORDINAL LINE REPLACES THE DESIGN REFERENCE'S STAR RATING, which does not exist
 * (BAL-422 is Backlog with no columns). It is not a patch over a hole: it is MORE relevant
 * than what it replaces, and it is additive-safe — when BAL-422 lands the rating slots in as
 * one more line in the same stack, with no structural change.
 *
 * ⚠⚠ NO EMAIL ADDRESS ANYWHERE. Not in the card, not in a `mailto:`, not in a `title`, and not
 * via a gravatar-style hash of one (ADR-1044). The avatar is `users.avatar_url` or initials.
 *
 * ⚠ ONLY LIVE DESTINATIONS RENDER, NEVER A DISABLED CTA. `/experts/{username}` is the ONE CTA
 * with a real route today — and `expert_profiles.username` is NULLABLE, so a null username
 * means NO button rather than a link to `/experts/null`. Turn into project, send proposal,
 * add a private note and offer a new time all have no destination and are simply absent. The
 * card reads complete with one action or with none.
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
      <div className="flex items-start gap-3">
        <PartyAvatar avatarUrl={party.avatarUrl} initials={party.initials} />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">{party.name}</p>
          {party.headline !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{party.headline}</p>
          )}
          {party.orgLabel !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs">{party.orgLabel}</p>
          )}
        </div>
      </div>

      {party.ordinalLine !== null && (
        <p className="border-border text-muted-foreground mt-4 border-t pt-3 text-xs">
          {party.ordinalLine}
        </p>
      )}

      {party.bookAgainHref !== null && (
        <div className="mt-4 flex flex-col gap-2">
          <Button asChild variant="outline" className="min-h-11 w-full gap-2">
            <Link href={party.bookAgainHref} onClick={onBookAgain}>
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
