'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { AlertCircle, FileText, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { AdminTriageCard as AdminTriageCardData } from '@/lib/projects-inbox/portfolio-row';
import { readTimeToFirstAction } from './projects-inbox-analytics';

/**
 * AdminTriageCard — a warning-bordered "Needs triage" hero card (the design's
 * admin triage hero). Shows a destructive `>24h` pill when the request has been
 * waiting over a day. The primary "Triage" CTA links to `/projects/{id}` and
 * fires `inbox_hero_cta_clicked`.
 */

interface AdminTriageCardProps {
  card: AdminTriageCardData;
  index: number;
}

export function AdminTriageCard({
  card,
  index,
}: Readonly<AdminTriageCardProps>): React.JSX.Element {
  const handleCtaClick = useCallback(() => {
    track(PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED, {
      lens: 'admin',
      request_id: card.id,
      stage: 'requested',
      nudge: 'Triage',
      time_to_first_action_ms: readTimeToFirstAction(),
    });
  }, [card.id]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.08 + index * 0.05 }}
      className="border-warning/40 bg-card flex flex-col rounded-2xl border p-5"
    >
      <div className="mb-1.5 flex items-start gap-2">
        <p className="text-foreground flex-1 text-sm font-semibold">{card.title}</p>
        {card.overdue && (
          <span className="bg-destructive/10 text-destructive inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            &gt;24h
          </span>
        )}
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {card.companyName ?? 'Unknown company'} · raised {card.raisedRelative}
      </p>
      <div className="mt-auto flex gap-2">
        <Link
          href={card.href}
          onClick={handleCtaClick}
          className={cn(
            'bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          Triage
        </Link>
        <Link
          href={card.href}
          onClick={handleCtaClick}
          aria-label={`Open ${card.title}`}
          className="border-border text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </motion.div>
  );
}
