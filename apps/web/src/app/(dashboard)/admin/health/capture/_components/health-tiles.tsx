import Link from 'next/link';
import { Film, Mic, FileText, CheckCircle2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CaptureHealthCategory } from '@balo/shared/capture-health';

/**
 * BAL-550 — the four tile filters (design reference `HealthPanel`'s `tiles`, `admin-home.jsx:
 * 2019-2065`). Server Component, pure `<Link>`s — the `GroupTiles` idiom (`admin/_components/
 * group-tiles.tsx`): a full navigation to `?category=<key>`, or back to the unfiltered view
 * when the tile is already active.
 */
const TILE_ORDER: readonly CaptureHealthCategory[] = [
  'recording',
  'transcription',
  'recap',
  'healthy',
];

const TILE_LABEL: Readonly<Record<CaptureHealthCategory, string>> = {
  recording: 'Recording issues',
  transcription: 'Transcription issues',
  recap: 'Recap issues',
  healthy: 'Healthy',
};

const TILE_ICON: Readonly<Record<CaptureHealthCategory, LucideIcon>> = {
  recording: Film,
  transcription: Mic,
  recap: FileText,
  healthy: CheckCircle2,
};

const TILE_TONE: Readonly<
  Record<
    CaptureHealthCategory,
    { readonly text: string; readonly bgOn: string; readonly borderOn: string }
  >
> = {
  recording: {
    text: 'text-destructive',
    bgOn: 'bg-destructive/10',
    borderOn: 'border-destructive/50',
  },
  transcription: { text: 'text-warning', bgOn: 'bg-warning/10', borderOn: 'border-warning/50' },
  recap: { text: 'text-violet', bgOn: 'bg-violet/10', borderOn: 'border-violet/50' },
  healthy: { text: 'text-success', bgOn: 'bg-success/10', borderOn: 'border-success/50' },
};

interface HealthTilesProps {
  readonly counts: Record<CaptureHealthCategory, number>;
  readonly active: CaptureHealthCategory | null;
  /** The window's OWN query params — preserved on every tile link so clicking a tile never
   *  silently resets the date range back to the default 30 days. */
  readonly windowParams: { readonly from?: string; readonly to?: string };
}

function buildHref(
  category: CaptureHealthCategory | null,
  windowParams: { readonly from?: string; readonly to?: string }
): string {
  const params = new URLSearchParams();
  if (windowParams.from !== undefined) params.set('from', windowParams.from);
  if (windowParams.to !== undefined) params.set('to', windowParams.to);
  if (category !== null) params.set('category', category);
  const query = params.toString();
  return query.length === 0 ? '?' : `?${query}`;
}

/** The tile's one-word status line. A named helper, not a nested ternary (sonarjs/no-nested-conditional). */
function tileCaption(key: CaptureHealthCategory, count: number): string {
  if (key === 'healthy') return 'nothing to do';
  return count > 0 ? 'needs a look' : 'none';
}

export function HealthTiles({
  counts,
  active,
  windowParams,
}: Readonly<HealthTilesProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {TILE_ORDER.map((key) => {
        const Icon = TILE_ICON[key];
        const tone = TILE_TONE[key];
        const isActive = active === key;
        const href = buildHref(isActive ? null : key, windowParams);
        const count = counts[key];
        return (
          <Link
            key={key}
            href={href}
            title={TILE_LABEL[key]}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring rounded-2xl border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
              isActive ? cn(tone.borderOn, tone.bgOn) : 'border-border bg-card hover:bg-muted/50'
            )}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Icon className={cn('size-3.5', tone.text)} aria-hidden="true" />
              <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
                {TILE_LABEL[key]}
              </span>
            </div>
            <p
              className={cn(
                'text-[26px] leading-none font-extrabold tabular-nums',
                count > 0 ? tone.text : 'text-muted-foreground'
              )}
            >
              {count}
            </p>
            <p className="text-muted-foreground mt-1 text-[11.5px]">{tileCaption(key, count)}</p>
          </Link>
        );
      })}
    </div>
  );
}
