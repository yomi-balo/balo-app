'use client';

import { ArrowLeft, Clock, ClipboardList } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type { ApplicationWithRelations, CertificationsByCategory, SupportType } from '@balo/db';
import { formatSubmittedDate } from '@/lib/expert/application-derived-data';
import { summaryFromApplication } from '@/lib/expert/application-summary';
import { ApplicationSummarySections } from '../../_components/application-summary-sections';

// ── Animation helpers ──────────────────────────────────────────

const slideUp = {
  initial: { y: 16, opacity: 0 },
  animate: { y: 0, opacity: 1 },
};

function staggerDelay(
  i: number,
  base = 0.06
): { transition: { delay: number; duration: number; ease: 'easeOut' } } {
  return { transition: { delay: i * base, duration: 0.4, ease: 'easeOut' as const } };
}

// ── Props ──────────────────────────────────────────────────────

interface ApplicationReviewProps {
  application: ApplicationWithRelations;
  email: string;
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
}

// ── Main Component ─────────────────────────────────────────────

export function ApplicationReview({
  application,
  email,
  supportTypes,
  certificationsByCategory,
}: Readonly<ApplicationReviewProps>): React.JSX.Element {
  const submittedDate = formatSubmittedDate(application.profile.submittedAt);
  const summary = summaryFromApplication(application, { supportTypes, certificationsByCategory });

  return (
    <div className="mx-auto max-w-[780px] py-8 pb-20">
      {/* Page header */}
      <motion.div {...slideUp} transition={{ duration: 0.4, ease: 'easeOut' }} className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <div className="bg-primary/10 border-primary/25 flex h-10 w-10 items-center justify-center rounded-[11px] border">
            <ClipboardList className="text-primary h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-foreground text-[26px] font-bold tracking-tight">Your Application</h1>
        </div>
        <p className="text-muted-foreground ml-[52px] text-sm leading-relaxed">
          Here&apos;s a summary of your expert application. You&apos;ll be notified once it&apos;s
          reviewed.
        </p>
      </motion.div>

      {/* Status Banner */}
      <motion.div
        {...slideUp}
        transition={{ duration: 0.4, ease: 'easeOut', delay: 0.06 }}
        className="mb-9"
      >
        <div className="bg-primary/5 border-primary/20 flex items-center gap-3.5 rounded-[14px] border px-6 py-4">
          <div className="bg-primary text-primary-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]">
            <Clock className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-foreground text-sm font-semibold">Application under review</p>
            <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
              Submitted on {submittedDate}. We&apos;ll email you at{' '}
              <strong className="text-foreground">{email}</strong> within 2–3 business days.
            </p>
          </div>
        </div>
      </motion.div>

      <motion.div {...slideUp} {...staggerDelay(2)}>
        <ApplicationSummarySections summary={summary} />
      </motion.div>

      {/* Back to Dashboard */}
      <motion.div {...slideUp} {...staggerDelay(9)} className="mt-12 text-center">
        <Link
          href="/dashboard"
          className="bg-card text-foreground border-border hover:border-primary/40 focus-visible:ring-ring inline-flex items-center gap-2 rounded-[10px] border px-8 py-3 text-[15px] font-semibold transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Dashboard
        </Link>
      </motion.div>
    </div>
  );
}
