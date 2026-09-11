import Link from 'next/link';
import { Users, DollarSign, Film, Calendar, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdminQueueTileView } from '../_lib/admin-queue-view';
import type { AdminAlertTileGroup } from '@balo/shared/admin-alerts';

/**
 * BAL-548 / ADR-1055 — the four group tiles: the queue's filter control (design reference
 * `admin-home.jsx`'s `StatTiles`, `:537`). Server Component, pure `<Link>`s — a full navigation
 * to `/admin?group=<key>`, or back to `/admin` when the tile is already active (click again ⇒
 * clear the filter). No client state: the filter is server-resolved from `searchParams`.
 *
 * Icons per the design reference's group→icon mapping (`admin-home.jsx:641-670`): Users
 * (marketplace), DollarSign (money), Film (capture), Calendar (meetings). Colour roles are
 * semantic tokens only — `primary` / `warning` / `violet` / `info` — never a hex value.
 */
const TILE_ICONS: Readonly<Record<AdminAlertTileGroup, LucideIcon>> = {
  marketplace: Users,
  money: DollarSign,
  capture: Film,
  meetings: Calendar,
};

const TILE_TONE: Readonly<
  Record<
    AdminAlertTileGroup,
    { readonly text: string; readonly bgOn: string; readonly borderOn: string }
  >
> = {
  marketplace: { text: 'text-primary', bgOn: 'bg-primary/10', borderOn: 'border-primary/50' },
  money: { text: 'text-warning', bgOn: 'bg-warning/10', borderOn: 'border-warning/50' },
  capture: { text: 'text-violet', bgOn: 'bg-violet/10', borderOn: 'border-violet/50' },
  meetings: { text: 'text-info', bgOn: 'bg-info/10', borderOn: 'border-info/50' },
};

interface GroupTilesProps {
  readonly tiles: readonly AdminQueueTileView[];
}

export function GroupTiles({ tiles }: Readonly<GroupTilesProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {tiles.map((tile) => {
        const Icon = TILE_ICONS[tile.key];
        const tone = TILE_TONE[tile.key];
        const href = tile.active ? '/admin' : `/admin?group=${tile.key}`;
        return (
          <Link
            key={tile.key}
            href={href}
            title={tile.hint}
            aria-current={tile.active ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring rounded-2xl border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
              tile.active ? cn(tone.borderOn, tone.bgOn) : 'border-border bg-card hover:bg-muted/50'
            )}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Icon className={cn('size-3.5', tone.text)} aria-hidden="true" />
              <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
                {tile.label}
              </span>
            </div>
            <p
              className={cn(
                'text-[26px] leading-none font-extrabold tabular-nums',
                tile.count > 0 ? tone.text : 'text-muted-foreground'
              )}
            >
              {tile.count}
            </p>
            <p className="text-muted-foreground mt-1 text-[11.5px]">
              {tile.oldestAgeLabel === null ? 'nothing open' : `oldest ${tile.oldestAgeLabel}`}
            </p>
          </Link>
        );
      })}
    </div>
  );
}
