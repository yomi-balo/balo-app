'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgencyPortfolioDTO } from '@/lib/projects-inbox/portfolio-row';

/**
 * AgencyPicker — scopes the agency lens to one agency for a viewer who oversees two or more.
 * Writes `?lens=agency&agency=` with `router.replace` (shareable, server-rendered); the loader
 * re-validates the id against the viewer's own set. Renders nothing for a single agency.
 */

interface AgencyPickerProps {
  agencies: AgencyPortfolioDTO['agencies'];
  selectedId: string;
}

export function AgencyPicker({
  agencies,
  selectedId,
}: Readonly<AgencyPickerProps>): React.JSX.Element | null {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleChange = useCallback(
    (id: string) => {
      if (id === selectedId) return;
      track(PROJECTS_INBOX_EVENTS.INBOX_AGENCY_SWITCHED, { agency_count: agencies.length });
      const params = new URLSearchParams(searchParams.toString());
      params.set('lens', 'agency');
      params.set('agency', id);
      router.replace(`/projects?${params.toString()}`, { scroll: false });
    },
    [selectedId, agencies.length, router, searchParams]
  );

  if (agencies.length < 2) return null;

  const current = agencies.find((agency) => agency.id === selectedId);

  return (
    <Select value={selectedId} onValueChange={handleChange}>
      <SelectTrigger
        aria-label={`Agency: ${current?.name ?? ''}`}
        className="h-11 w-full gap-2 rounded-[10px] md:h-9 md:max-w-[320px]"
      >
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Agency</span>
            <Building2 className="text-success h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="text-foreground truncate font-semibold">{current?.name}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {agencies.map((agency) => (
          <SelectItem key={agency.id} value={agency.id}>
            <span className="flex flex-1 items-center gap-2">
              {agency.name}
              <span className="text-muted-foreground ml-auto pl-2 tabular-nums">
                {agency.liveCount}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
