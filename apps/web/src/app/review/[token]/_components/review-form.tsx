'use client';

import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, MessageSquareQuote, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  RATING_LABELS,
  REVIEW_BODY_MAX,
  type Rating,
  type ReviewLandingContext,
} from '@balo/shared/reviews';
import { RatingInput } from '@/components/balo/rating-input';
import { Textarea } from '@/components/ui/textarea';
import { formatUtcLongDate } from '@/lib/format/local-date';
import { cn } from '@/lib/utils';
import { submitTokenReviewAction } from '@/app/review/_actions/submit-token-review';

/**
 * ReviewForm — the `/review/{token}` capture surface (BAL-390, Artifact 3).
 *
 * ⚠ ITS ONLY IDENTITY FIELD IS THE TOKEN. No engagement id, no reviewer id, no expert id
 * is ever posted from here; the action derives all three server-side. There is nothing
 * in this component a hostile client could tamper with to write somewhere else.
 *
 * ⚠ NOTHING IS WRITTEN UNTIL SUBMIT. Arriving with `?r=4` only PREFILLS — the copy says
 * so, because a star tap that felt inert would be worse than one that wrote.
 *
 * ALL COPY IS DRAFT, pending MJ sign-off, and gender-neutral throughout.
 *
 * Toast rule, deliberately deviating from CLAUDE.md's "toast every mutation": the FIRST
 * submit swaps the whole card for the success state, which IS the confirmation — a toast
 * on top of it is noise. The `Change my review` → resubmit path DOES toast, because from
 * the user's point of view the page barely changes there.
 */

interface ExistingReview {
  rating: Rating;
  body: string | null;
  ratedOnIso: string;
}

/**
 * The review that is LIVE on the server as far as this component can tell — which is NOT
 * always the `existing` prop.
 *
 * `existing` is a SERVER prop, captured once at first render. `submitTokenReviewAction`
 * calls no `revalidatePath` (this route is `dynamic = 'force-dynamic'` and
 * unauthenticated, so there is no cache entry to bust, and revalidating would re-run the
 * whole token resolution and re-stamp an access). So the moment this session sends
 * anything, `existing` is STALE — it would still say "You rated Amara 3 out of 5 on 12
 * July" after a resubmit that made it a 5. Post-submit state therefore wins over it.
 */
interface LiveReview {
  rating: Rating;
  /** `null` when it was sent in THIS session — "a moment ago", no server date to quote. */
  ratedOnIso: string | null;
}

export interface ReviewFormProps {
  /** The raw magic-link token. The ONLY thing this form posts besides the review. */
  token: string;
  context: ReviewLandingContext;
  /** The `?r=` prefill: a star tapped in the email, or `null`. */
  prefill: Rating | null;
  existing: ExistingReview | null;
}

type Phase = 'idle' | 'error' | 'success';

const KIND_LABEL: Readonly<Record<ReviewLandingContext['engagementKind'], string>> = {
  project: 'Project',
  case: 'Case',
};

export function ReviewForm({
  token,
  context,
  prefill,
  existing,
}: Readonly<ReviewFormProps>): React.JSX.Element {
  const [rating, setRating] = useState<Rating | null>(prefill ?? existing?.rating ?? null);
  const [body, setBody] = useState<string>(existing?.body ?? '');
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sentRating, setSentRating] = useState<Rating | null>(null);
  const [sentBody, setSentBody] = useState<string>('');
  const [hasSent, setHasSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleChange = useCallback((next: Rating): void => {
    setTouched(true);
    setRating(next);
  }, []);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (rating === null || isPending) {
        return;
      }
      const trimmed = body.trim();
      // A resubmit is the ONLY path that toasts — see the component docblock.
      const isResubmit = hasSent;

      startTransition(async () => {
        const result = await submitTokenReviewAction({
          token,
          rating,
          ...(trimmed.length === 0 ? {} : { body: trimmed }),
        });

        if (result.success) {
          setSentRating(rating);
          setSentBody(trimmed);
          setError(null);
          setPhase('success');
          setHasSent(true);
          if (isResubmit) {
            toast.success('Your review is updated');
          }
          return;
        }

        setError(result.error);
        setPhase('error');
        if (isResubmit) {
          toast.error(result.error);
        }
      });
    },
    [body, hasSent, isPending, rating, token]
  );

  const handleChangeMyReview = useCallback((): void => {
    setPhase('idle');
    setTouched(true);
  }, []);

  if (phase === 'success' && sentRating !== null) {
    return (
      <ReviewSent
        rating={sentRating}
        body={sentBody}
        expertGivenName={context.expertGivenName}
        onChangeReview={handleChangeMyReview}
      />
    );
  }

  const showMistapHint = prefill !== null && !touched;

  // What a resubmit would REPLACE: this session's own send once there has been one,
  // otherwise the server's. See `LiveReview`. This also drives the CTA, so "Change my
  // review" → the button reads "Update my review" even when there was no prior review.
  const live: LiveReview | null =
    hasSent && sentRating !== null ? { rating: sentRating, ratedOnIso: null } : existing;

  return (
    <form
      onSubmit={handleSubmit}
      className="border-border bg-card animate-slide-up mx-auto w-full max-w-md rounded-2xl border p-6 shadow-sm sm:p-8"
    >
      <ContextCard context={context} />

      <h1 className="text-foreground mt-6 text-[19px] leading-snug font-semibold">
        How was working with {context.expertGivenName}?
      </h1>
      <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
        One tap is plenty. A line or two helps the next client even more.
      </p>

      {live !== null && (
        <div className="border-info/30 bg-info/10 text-foreground mt-5 rounded-xl border p-3.5 text-[12.5px] leading-relaxed">
          You rated {context.expertGivenName} {live.rating} out of 5{' '}
          {live.ratedOnIso === null ? 'a moment ago' : `on ${formatUtcLongDate(live.ratedOnIso)}`}.
          Sending this replaces that — nothing changes until you do.
        </div>
      )}

      <div className="mt-6">
        <RatingInput
          value={rating}
          onChange={handleChange}
          size={48}
          disabled={isPending}
          label={`How was working with ${context.expertGivenName}?`}
          placeholder="Pick a star to send your review"
          className={cn(isPending && 'opacity-65')}
        />
      </div>

      {showMistapHint && (
        <p className="text-muted-foreground animate-fade-in mt-3 text-center text-[12px] leading-relaxed">
          That&apos;s the star you tapped in the email — tap a different one if it&apos;s not right.
        </p>
      )}

      {rating !== null && (
        <div className="animate-fade-in mt-6">
          <label
            htmlFor="review-body"
            className="text-foreground text-[13px] leading-none font-medium"
          >
            Anything you&apos;d add? <span className="text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="review-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={REVIEW_BODY_MAX}
            disabled={isPending}
            rows={4}
            placeholder="What went well, or what would have helped?"
            className="mt-2"
          />
          <p className="text-muted-foreground mt-1.5 text-right text-[11.5px] tabular-nums">
            {body.length}/{REVIEW_BODY_MAX}
          </p>
        </div>
      )}

      <Disclosure context={context} />

      {phase === 'error' && error !== null && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-foreground animate-shake mt-5 flex gap-2.5 rounded-xl border p-3.5 text-[12.5px] leading-relaxed"
        >
          <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={rating === null || isPending}
        className="from-primary focus-visible:ring-ring mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r to-violet-600 px-4 text-[14px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        {isPending && (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        )}
        {submitLabel(isPending, phase, live !== null)}
      </button>

      {/*
        "Pick a star …" is NOT repeated here. It already renders ~200px above as the
        RatingInput's live label, and the same sentence twice on one short card reads as
        a rendering bug. This line says the thing that line cannot: nothing has been
        written yet — true in every pre-submit state, so it does not flicker either.
      */}
      <p className="text-muted-foreground mt-3 text-center text-[11.5px]">
        Nothing is saved until you send it.
      </p>
    </form>
  );
}

/** DRAFT copy. The button says what pressing it does, in every phase. */
function submitLabel(isPending: boolean, phase: Phase, isUpdate: boolean): string {
  if (isPending) return 'Sending your review…';
  if (phase === 'error') return 'Try again';
  return isUpdate ? 'Update my review' : 'Send my review';
}

/**
 * What they are being asked about, ABOVE the stars, on every viewport and never
 * collapsible — a recipient can be 37 days out from the last consultation and genuinely
 * unable to place it.
 *
 * ⚠ HERE — and ONLY here — the expert is named by PARTY (`expertPartyLabel`: the agency,
 * or the person when independent). This card answers "what am I being asked about", and
 * the party is who the client contracted with, so the party is the right identity for it.
 * The VISIBILITY disclosure below deliberately does NOT reuse this label — see there.
 *
 * `findLandingContext` does hold both halves of the person's full name (it selects
 * `expertFirstName` AND `expertLastName` and feeds them to `expertPartyDisplayName`), so
 * a "{Person} @ {Agency}" fusion would be constructible, not guessed. It is left out of
 * `ReviewLandingContext` because this card wants one party label and the copy elsewhere
 * wants a warm given name — not because the surname is unavailable.
 */
function ContextCard({ context }: Readonly<{ context: ReviewLandingContext }>): React.JSX.Element {
  return (
    <div className="border-border bg-muted/30 flex gap-3 rounded-xl border p-3.5">
      <span className="border-border bg-card flex size-10 shrink-0 items-center justify-center rounded-lg border">
        <MessageSquareQuote className="text-muted-foreground size-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-foreground truncate text-[13.5px] font-semibold">{context.title}</p>
        <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
          {KIND_LABEL[context.engagementKind]} with {context.expertPartyLabel}, for{' '}
          {context.clientCompanyName}
          {context.concludedOnIso !== null && (
            <> · wrapped up {formatUtcLongDate(context.concludedOnIso)}</>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The two disclosures, both required and both DRAFT.
 *
 * 1. VISIBILITY (D6) — it must be literally true of the code: `listPublicByExpert`
 *    projects the rating, the body and the CLIENT COMPANY name, and structurally cannot
 *    project `reviewer_user_id`.
 *
 *    ⚠⚠ IT NAMES THE PERSON, NOT `expertPartyLabel`. `listPublicByExpert` is keyed on
 *    `expert_profile_id`, and the only public profile route in the app is
 *    `(marketing)/experts/[username]` — the INDIVIDUAL expert's page (BAL-422's mount
 *    point). There is no agency profile route anywhere. Saying "CloudPeak Consulting's
 *    Balo profile" to someone deciding how frank to be about an agency, when the review
 *    lands on Amara's own page, is precisely the mistake a visibility disclosure cannot
 *    make. Use `expertGivenName` here even though the context card above says the party.
 * 2. FORWARDED TOKEN — the token binds ONE person, so a forwarded email lands a review
 *    under the original recipient's name. FIRST NAME ONLY: rendering an email address to
 *    whoever holds a forwarded link would be a gratuitous PII mistake, and
 *    `ReviewLandingContext` exposes no address to make it with.
 */
function Disclosure({ context }: Readonly<{ context: ReviewLandingContext }>): React.JSX.Element {
  return (
    <div className="border-border text-muted-foreground mt-6 space-y-2 border-t pt-4 text-[11.5px] leading-relaxed">
      <p>
        Your review is published on {context.expertGivenName}&apos;s Balo expert profile — your
        rating, what you wrote, and your company name,{' '}
        <span className="text-foreground font-medium">{context.clientCompanyName}</span>. Your own
        name is not shown.
      </p>
      <p>
        This link was sent to{' '}
        <span className="text-foreground font-medium">{context.reviewerFirstName}</span>. Whatever
        you send here is recorded as {context.clientCompanyName}&apos;s review of{' '}
        {context.expertGivenName}, and is submitted under {context.reviewerFirstName}&apos;s name.
        If this was forwarded to you, ask them to send it themselves.
      </p>
    </div>
  );
}

/**
 * The post-submit state. It echoes the rating back IN WORDS and quotes what was written,
 * so a mis-tap is still legible after the fact — and offers both next steps: change it,
 * or go and find the engagement (they are logged out, so say where that goes).
 */
function ReviewSent({
  rating,
  body,
  expertGivenName,
  onChangeReview,
}: Readonly<{
  rating: Rating;
  body: string;
  expertGivenName: string;
  onChangeReview: () => void;
}>): React.JSX.Element {
  return (
    <div className="border-border bg-card animate-slide-up mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
      <span className="relative mx-auto flex size-14 items-center justify-center">
        <span
          className="bg-success/25 absolute inset-0 rounded-full motion-safe:animate-[ping_0.9s_ease-out_1]"
          aria-hidden="true"
        />
        <CheckCircle2 className="text-success relative size-9" aria-hidden="true" />
      </span>

      <h1 className="text-foreground mt-4 text-lg font-semibold">
        Thank you — that&apos;s genuinely useful.
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        You rated {expertGivenName} {rating} out of 5 — {RATING_LABELS[rating]}.
      </p>

      {body.length > 0 && (
        <blockquote className="border-border bg-muted/30 text-foreground mt-4 rounded-xl border p-3.5 text-left text-[12.5px] leading-relaxed">
          {body}
        </blockquote>
      )}

      <button
        type="button"
        onClick={onChangeReview}
        className="text-primary focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-[13px] font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        Change my review
      </button>

      <p className="text-muted-foreground border-border mt-4 border-t pt-4 text-[12px] leading-relaxed">
        Want the full picture?{' '}
        <Link
          href="/login"
          className="text-primary font-semibold hover:underline focus-visible:underline"
        >
          Sign in to see the engagement
        </Link>
        .
      </p>
    </div>
  );
}
