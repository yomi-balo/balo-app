'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight, CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import { DASHBOARD_UP_NEXT_MEETING_TYPES } from '@balo/analytics/events';
import { useViewerClock } from '@/hooks/use-viewer-clock';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { resolveUpNextRowTiming } from '../_lib/up-next-presentation';
import {
  UP_NEXT_COPY,
  UP_NEXT_EMPTY_TITLE,
  UP_NEXT_ERROR,
  UP_NEXT_FIND_EXPERT,
  UP_NEXT_FIND_EXPERT_HREF,
  UP_NEXT_RETRY,
  UP_NEXT_TITLE,
} from '../_lib/up-next-copy';
import { UpNextRow } from './up-next-row';
import type { UpNextData, UpNextFooterLink, UpNextWorkspaceType } from '../_lib/up-next-view-types';

interface UpNextCardProps {
  readonly data: UpNextData;
  readonly workspaceType: UpNextWorkspaceType;
  readonly subtitle: string;
  readonly footerLinks: readonly UpNextFooterLink[];
}

/** Only the company workspace's Empty state offers the "Find an expert" CTA. */
const SHOWS_FIND_EXPERT: Record<UpNextWorkspaceType, boolean> = {
  company: true,
  expert: false,
};

export function UpNextCard({
  data,
  workspaceType,
  subtitle,
  footerLinks,
}: Readonly<UpNextCardProps>): React.JSX.Element {
  const clock = useViewerClock();
  useRefreshOnFocus();
  const router = useRouter();
  const viewedRef = useRef(false);

  const visibleRows = useMemo(() => {
    if (data.kind !== 'ready') return [];
    if (clock === null) return data.rows;
    return data.rows.filter((row) => resolveUpNextRowTiming(row, clock.now).visible);
  }, [data, clock]);

  const featuredMeetingId = useMemo(() => {
    if (clock === null) return null;
    const featured = visibleRows.find((row) => resolveUpNextRowTiming(row, clock.now).joinVisible);
    return featured?.meetingId ?? null;
  }, [visibleRows, clock]);

  useEffect(() => {
    if (viewedRef.current || data.kind !== 'ready') return;
    viewedRef.current = true;
    track(DASHBOARD_EVENTS.UP_NEXT_VIEWED, {
      workspace_type: workspaceType,
      row_count: data.rows.length,
      meeting_types: DASHBOARD_UP_NEXT_MEETING_TYPES.filter((type) =>
        data.rows.some((row) => row.contextType === type)
      ),
    });
    // F10 — `viewedRef` keeps this firing exactly once regardless of how many times the effect
    // re-runs (a re-render from the 60s tick, a `workspaceType` prop change), so the full,
    // honest dep list is safe here: no disable needed.
  }, [data, workspaceType]);

  const handleFooterLinkClick = (target: UpNextFooterLink['target']): void => {
    track(DASHBOARD_EVENTS.UP_NEXT_CLICKED, { target, meeting_type: null, row_state: null });
  };

  const handleFindExpertClick = (): void => {
    track(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'find_expert',
      meeting_type: null,
      row_state: null,
    });
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      aria-labelledby="up-next-heading"
      className="bg-card border-border rounded-2xl border px-[18px] pt-[18px] pb-1.5 shadow-sm"
    >
      <h2 id="up-next-heading" className="text-foreground text-[17px] font-semibold tracking-tight">
        {UP_NEXT_TITLE}
      </h2>
      <p className="text-muted-foreground mt-0.5 mb-3 text-[13px]">{subtitle}</p>

      {data.kind === 'error' && (
        <div className="flex items-center justify-between gap-3 py-4">
          <p className="text-muted-foreground text-sm">{UP_NEXT_ERROR}</p>
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            {UP_NEXT_RETRY}
          </Button>
        </div>
      )}

      {data.kind === 'ready' && visibleRows.length === 0 && (
        <div className="flex items-center gap-3 py-2.5 pb-4">
          <span
            aria-hidden="true"
            className="border-border text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-dashed"
          >
            <CalendarPlus className="size-5" />
          </span>
          <span className="flex-1">
            <span className="text-foreground block text-sm font-semibold">
              {UP_NEXT_EMPTY_TITLE}
            </span>
            <span className="text-muted-foreground block text-[13px]">
              {UP_NEXT_COPY[workspaceType].emptyBody}
            </span>
          </span>
          {SHOWS_FIND_EXPERT[workspaceType] && (
            <Button asChild size="sm">
              <Link href={UP_NEXT_FIND_EXPERT_HREF} onClick={handleFindExpertClick}>
                {UP_NEXT_FIND_EXPERT}
              </Link>
            </Button>
          )}
        </div>
      )}

      {data.kind === 'ready' &&
        visibleRows.map((row) => (
          <UpNextRow
            key={row.meetingId}
            row={row}
            clock={clock}
            workspaceType={workspaceType}
            featured={row.meetingId === featuredMeetingId}
          />
        ))}

      {/* The strip is a BORDER, so it only renders with links in it: `resolveUpNextFooterLinks`
          skips a nav entry the workspace doesn't have, and an empty list would otherwise draw a
          bare rule above the card edge. */}
      {footerLinks.length > 0 && (
        <div className="border-border mt-1.5 flex gap-[18px] border-t pt-3 pb-2.5">
          {footerLinks.map((link) => (
            <Link
              key={link.target}
              href={link.href}
              onClick={() => handleFooterLinkClick(link.target)}
              className="text-primary inline-flex items-center gap-1 text-[12.5px] font-semibold"
            >
              {link.label}
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </motion.section>
  );
}
