'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { ChevronRight, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { ProjectsInboxLens } from '@/lib/analytics';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { StageChip } from './stage-chip';
import { readTimeToFirstAction } from './projects-inbox-analytics';

/**
 * HeroCard — a needs-you item promoted to an action card (the design's
 * `HeroCard`). Left gradient strip, freshest-signal block, gradient primary CTA
 * (the nudge → `row.href`) reusing `PROPOSAL_CTA_GRADIENT_CLASS`, secondary
 * chevron link. Unread → pulsing primary dot. Fires `inbox_hero_cta_clicked` on
 * the primary CTA (with `time_to_first_action_ms`). These rows ALSO appear,
 * badged, in the list below (promotion, not partition).
 */

interface HeroCardProps {
  row: PortfolioRowView;
  lens: ProjectsInboxLens;
  index: number;
}

export function HeroCard({ row, lens, index }: Readonly<HeroCardProps>): React.JSX.Element {
  const handleCtaClick = useCallback(() => {
    track(PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED, {
      lens,
      request_id: row.kind === 'engagement' ? null : row.id,
      stage: row.stage,
      nudge: row.nudgeLabel,
      time_to_first_action_ms: readTimeToFirstAction(),
    });
  }, [lens, row.kind, row.id, row.stage, row.nudgeLabel]);

  const href = row.href ?? '#';

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.08 + index * 0.06 }}
      className="border-primary/40 bg-card relative flex flex-col gap-3 overflow-hidden rounded-2xl border p-5 shadow-sm"
    >
      <span
        className="from-primary absolute inset-y-0 left-0 w-1 bg-gradient-to-b to-violet-600 dark:to-violet-500"
        aria-hidden="true"
      />
      <div className="flex items-center gap-2">
        {row.unread && (
          <span
            className="bg-primary h-2 w-2 shrink-0 animate-pulse rounded-full"
            aria-label="Unread activity"
          />
        )}
        <p className="text-foreground min-w-0 flex-1 text-sm font-semibold">{row.title}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.companyName && (
          <span className="text-muted-foreground text-xs">{row.companyName}</span>
        )}
        <StageChip stage={row.stage} label={row.stageLabel} />
        <span className="text-muted-foreground text-xs">{row.updatedRelative}</span>
      </div>
      {row.signal && (
        <div className="bg-muted rounded-xl px-3 py-2.5">
          <p className="text-foreground text-xs leading-relaxed">
            <strong className="font-semibold">{row.signal.from}:</strong>{' '}
            {row.signal.messagePreview}
          </p>
        </div>
      )}
      <div className="mt-auto flex gap-2">
        <Link
          href={href}
          onClick={handleCtaClick}
          className={cn(
            'focus-visible:ring-ring inline-flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
            PROPOSAL_CTA_GRADIENT_CLASS
          )}
        >
          <Zap className="h-4 w-4" aria-hidden="true" />
          {row.nudgeLabel}
        </Link>
        <Link
          href={href}
          onClick={handleCtaClick}
          aria-label={`Open ${row.title}`}
          className="border-border text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </motion.div>
  );
}
