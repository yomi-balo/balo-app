'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { Video } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { InlineRating } from '@/components/balo/rating-display';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import type { CaseEarningsView, CasePartyView } from '@/lib/cases/case-view-types';
import type { BookingFlowExpert } from '@/components/booking';
import { CaseEarningsBlock } from './case-earnings-block';
import { CaseSlotQuickPick } from './case-slot-quick-pick';

/**
 * BAL-421 — the rail's counterparty card. ONE component for both lenses, because the two
 * differ only in which optional blocks appear; the SERVER already decided who the
 * counterparty is and what they are called.
 *
 * ⚠⚠ NO EMAIL ADDRESS ANYWHERE (ADR-1044). Not in the card, not in a `mailto:`, not in a
 * `title`, and not via a gravatar-style hash of one. The avatar is `users.avatar_url` or
 * initials — and NOTHING in `CasePartyView` can carry an address, by construction.
 *
 * ⚠ THE RATING LINE IS REAL DATA, AND IT IS CLIENT-LENS ONLY (BAL-422). It landed exactly as
 * the earlier docblock promised — ONE more null-gated line in this same stack, no structural
 * change, nothing faked. `party.ratingAverage` is `null` for an unrated expert AND on the
 * expert lens (where the counterparty is the client company), and the line simply does not
 * render. NEVER coalesce it to `0`: the scale starts at 1, so 0.0 would be a fabricated
 * rating, and nothing evaluative may appear on the expert lens at all.
 *
 * ⚠ THE EARNINGS BLOCK IS PASSED, NEVER DERIVED. A client-lens `CaseSurfaceView` has no
 * `earnings` field at all, so the caller cannot supply one — the fee-concealment invariant is
 * enforced by the type, not by a conditional here.
 */
interface CasePartyCardProps {
  party: CasePartyView;
  lens: 'client' | 'expert';
  /** Expert lens only — a client-lens view structurally cannot carry one. */
  earnings?: CaseEarningsView;
  /** Copy differs on a CLOSED case: booking then starts a NEW case, and says so. */
  isOpen: boolean;
  counterpartyFirstName: string;
  /** BAL-400 (D4a) — client lens + open case only; used by `CaseSlotQuickPick`. */
  engagementId: string;
  expertProfileId: string;
  caseTitle: string;
  consultationCount: number;
  openedAtIso: string;
  /**
   * UX-2 (BAL-400 round 2) — the viewer's SESSION-derived email domain, passed through
   * unchanged to `CaseSlotQuickPick` → the guest composer. NOT case-view PII (`CasePartyView`
   * carries no email, by design) — it originates in the page's `getCurrentUser()` read.
   */
  viewerEmailDomain: string | null;
}

export function CasePartyCard({
  party,
  lens,
  earnings,
  isOpen,
  counterpartyFirstName,
  engagementId,
  expertProfileId,
  caseTitle,
  consultationCount,
  openedAtIso,
  viewerEmailDomain,
}: Readonly<CasePartyCardProps>): React.JSX.Element {
  const onBookAnother = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'book_another', lens });
  }, [lens]);

  const avatarSrc = getAvatarUrl(party.avatarUrl, 'thumbnail');

  // BAL-400 — the quick-pick's `BookingFlowExpert`, built from the party view's already-loaded
  // fields. `verified`/`availableForWork` have no equivalent on `CasePartyView` (this card
  // never showed either), so they default rather than triggering a second read.
  const quickPickExpert: BookingFlowExpert = {
    expertProfileId,
    name: party.name,
    firstName: counterpartyFirstName,
    initials: party.initials,
    avatarUrl: avatarSrc,
    partyLabel: party.orgLabel ?? party.name,
    verified: false,
    availableForWork: true,
  };

  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
      <div className="flex items-start gap-3">
        <Avatar size="lg" className="flex-none">
          {avatarSrc !== null && <AvatarImage src={avatarSrc} alt="" />}
          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
            {party.initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">{party.name}</p>
          {party.headline !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{party.headline}</p>
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

      {/*
        ⚠ ONLY A LIVE DESTINATION RENDERS, NEVER A DISABLED CTA. `bookAgainHref` is
        `/experts/{username}` and `expert_profiles.username` is NULLABLE, so a null username
        means NO button rather than a link to `/experts/null`. The expert lens never has one:
        only a client can book.
      */}
      {party.bookAgainHref !== null && (
        <div className="mt-4">
          <Button asChild className="min-h-11 w-full gap-2">
            <Link href={`${party.bookAgainHref}?book=1&src=book_again`} onClick={onBookAnother}>
              <Video className="h-4 w-4" aria-hidden="true" />
              Book with {counterpartyFirstName} again
            </Link>
          </Button>
          {!isOpen && (
            <p className="text-muted-foreground mt-2 text-center text-xs leading-relaxed">
              Starts a new case — this one stays as it is.
            </p>
          )}
        </div>
      )}

      {/* BAL-400 (D4a entry point 3) — the next-available-slot quick-pick strip. Client lens,
          open case only; silently renders nothing without ready availability. */}
      {lens === 'client' && isOpen && (
        <CaseSlotQuickPick
          engagementId={engagementId}
          caseTitle={caseTitle}
          consultationCount={consultationCount}
          openedAtIso={openedAtIso}
          expertProfileId={expertProfileId}
          expert={quickPickExpert}
          viewerEmailDomain={viewerEmailDomain}
        />
      )}

      {earnings !== undefined && <CaseEarningsBlock earnings={earnings} />}
    </section>
  );
}
