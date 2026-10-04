'use client';

import Link from 'next/link';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

export const APPLICATION_REVIEW_TITLE = 'Your expert application is under review';
export const APPLICATION_REVIEW_CTA = 'View your application';
export const APPLICATION_REVIEW_HREF = '/expert/apply/review';

/**
 * The client dashboard's "under review" banner for someone whose expert application is awaiting
 * a decision. Copy follows the applicant review page and the submission confirmation ("We'll
 * email you … within 2–3 business days"), phrased so it stays true however long the review takes.
 * Informational, so primary-toned rather than the amber of an action-needed banner, and not
 * dismissible: it leaves on its own once the application is decided. A client leaf only for the
 * CTA's click event; `submittedOn` arrives already formatted by the server so the date never
 * differs between the server render and the browser's timezone.
 */
export function ApplicationReviewBanner({
  submittedOn,
  email,
}: Readonly<{ submittedOn: string | null; email: string }>): React.JSX.Element {
  const submitted = submittedOn === null ? '' : `Submitted on ${submittedOn}. `;
  return (
    <div
      role="status"
      className="bg-primary/5 border-primary/20 mb-6 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <Clock className="text-primary mt-0.5 size-[15px] shrink-0" aria-hidden="true" />
        <div>
          <p className="text-foreground text-sm font-semibold">{APPLICATION_REVIEW_TITLE}</p>
          <p className="text-muted-foreground text-[13px]">
            {submitted}We&apos;ll email you at{' '}
            <span className="text-foreground font-medium">{email}</span> as soon as there&apos;s a
            decision — usually within 2–3 business days.
          </p>
        </div>
      </div>
      <Button asChild size="sm" variant="outline" className="min-h-11 shrink-0">
        <Link
          href={APPLICATION_REVIEW_HREF}
          onClick={() => track(EXPERT_EVENTS.APPLICATION_REVIEW_BANNER_CLICKED, {})}
        >
          {APPLICATION_REVIEW_CTA}
        </Link>
      </Button>
    </div>
  );
}
