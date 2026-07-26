'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { IconBadge } from '@/components/balo/icon-badge';
import { getAvailabilityOverridesAction } from '../_actions/get-availability-overrides';
import { createAvailabilityOverrideAction } from '../_actions/create-availability-override';
import { deleteAvailabilityOverrideAction } from '../_actions/delete-availability-override';
import { DateOverrideAddPopover, type CreateOverrideInput } from './date-override-add-popover';
import { DateOverrideDeleteConfirm } from './date-override-delete-confirm';
import type { AvailabilityOverrideDto } from '../_types/availability-override';

/** Brand violet for the Time-off IconBadge (header + row tiles). */
const OVERRIDE_ICON_COLOR = '#7C3AED';

// ── Date formatting (display only; no timezone math) ─────────────

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const [ys, ms, ds] = iso.split('-');
  if (ys === undefined || ms === undefined || ds === undefined) return null;
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return { y, m, d };
}

function formatDay(iso: string, withWeekday: boolean): string {
  const parsed = parseIso(iso);
  if (!parsed) return iso;
  const month = MONTHS[parsed.m - 1] ?? '';
  const base = `${parsed.d} ${month} ${parsed.y}`;
  if (!withWeekday) return base;
  const weekday = WEEKDAYS[new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDay()] ?? '';
  return `${weekday}, ${base}`;
}

/** Single day → `Thu, 25 Dec 2026`; range → `25 Dec 2026 – 2 Jan 2027`. */
export function formatOverrideRange(startIso: string, endIso: string): string {
  if (startIso === endIso) return formatDay(startIso, true);
  return `${formatDay(startIso, false)} – ${formatDay(endIso, false)}`;
}

function sortByStart(list: AvailabilityOverrideDto[]): AvailabilityOverrideDto[] {
  return [...list].sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/**
 * Browser-local today as zero-padded `YYYY-MM-DD` — the expert's own current
 * date, which is the correct frame for a display-only "upcoming" list. Uses
 * LOCAL getters (mirrors the add-popover's `toIsoDate`); `toISOString()` would
 * be UTC and reintroduce the east-of-UTC skew this filter exists to remove.
 */
function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear().toString().padStart(4, '0');
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Row ──────────────────────────────────────────────────────────

interface DateOverrideRowProps {
  override: AvailabilityOverrideDto;
  onDelete: (id: string) => Promise<void>;
}

function DateOverrideRow({
  override,
  onDelete,
}: Readonly<DateOverrideRowProps>): React.JSX.Element {
  const rangeLabel = formatOverrideRange(override.startDate, override.endDate);
  const handleConfirm = useCallback(() => onDelete(override.id), [onDelete, override.id]);

  return (
    <div className="flex items-center gap-3 py-3">
      <IconBadge icon={CalendarDays} color={OVERRIDE_ICON_COLOR} size={40} iconSize={18} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-semibold">{rangeLabel}</div>
        <div className="text-muted-foreground mt-0.5 truncate text-sm">
          {override.label ?? 'Unavailable'}
        </div>
      </div>
      <DateOverrideDeleteConfirm rangeLabel={rangeLabel} onConfirm={handleConfirm} />
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────

type CardState = 'loading' | 'error' | 'ready';

export function DateOverridesCard(): React.JSX.Element {
  const [overrides, setOverrides] = useState<AvailabilityOverrideDto[]>([]);
  const [state, setState] = useState<CardState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getAvailabilityOverridesAction()
      .then((data) => {
        if (cancelled) return;
        setOverrides(sortByStart(data));
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = useCallback(async (input: CreateOverrideInput): Promise<boolean> => {
    const result = await createAvailabilityOverrideAction(input);
    if (result.success) {
      setOverrides((prev) => sortByStart([...prev, result.override]));
      toast.success('Time off added');
      return true;
    }
    toast.error(result.error);
    return false;
  }, []);

  const handleDelete = useCallback(async (id: string): Promise<void> => {
    const result = await deleteAvailabilityOverrideAction({ overrideId: id });
    if (result.success) {
      setOverrides((prev) => prev.filter((o) => o.id !== id));
      toast.success('Time off removed');
    } else {
      toast.error(result.error ?? 'Failed to remove time off');
    }
  }, []);

  // Display-frame filter: only blocks that end today-or-later in the expert's
  // OWN local timezone. The server window is deliberately wider (endDate >=
  // CURRENT_DATE - 1 day) so the resolver never drops a still-active block for
  // a west-of-UTC expert; that same widening makes yesterday's finished block
  // linger here for east-of-UTC (all AU) experts unless we re-narrow at render.
  // `overrides` is already sorted (sortByStart at every set), so filtering
  // preserves order; optimistic adds are today-or-future (picker disables past
  // dates) so they still show; deletes remove by id from the source list.
  const todayIso = localTodayIso();
  const visibleOverrides = overrides.filter((o) => o.endDate >= todayIso);

  return (
    <div className="border-border bg-card mt-4 rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconBadge icon={CalendarDays} color={OVERRIDE_ICON_COLOR} size={44} iconSize={22} />
          <div>
            <h2 className="text-foreground text-base font-semibold">Time off</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
              Block dates for holidays or leave — clients can&apos;t book you on blocked days.
            </p>
          </div>
        </div>
        <DateOverrideAddPopover onCreate={handleCreate} />
      </div>

      <div className="mt-4">
        {state === 'loading' && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">Loading time off</span>
          </div>
        )}

        {state === 'error' && (
          <div className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm leading-relaxed">
            Couldn&apos;t load your time off. Refresh the page to try again.
          </div>
        )}

        {state === 'ready' && visibleOverrides.length === 0 && (
          <div className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm leading-relaxed">
            No time off scheduled — add dates when you&apos;re unavailable.
          </div>
        )}

        {state === 'ready' && visibleOverrides.length > 0 && (
          <div className="divide-border divide-y">
            {visibleOverrides.map((override) => (
              <DateOverrideRow key={override.id} override={override} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
