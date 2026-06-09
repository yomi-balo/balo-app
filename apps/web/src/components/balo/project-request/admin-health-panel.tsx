import { Activity, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RequestRelationshipView } from '@/lib/project-request/request-detail-view';
import { RequestCard } from './request-card';

interface AdminHealthPanelProps {
  relationships: RequestRelationshipView[];
}

/** Per-relationship stage label + accent for the read-only pipeline list. */
const STAGE_META: Record<string, { label: string; tone: string }> = {
  invited: { label: 'Invited · awaiting EOI', tone: 'text-warning' },
  eoi_submitted: { label: 'EOI in · talking', tone: 'text-success' },
  proposal_requested: { label: 'Proposal requested', tone: 'text-primary' },
  proposal_submitted: { label: 'Proposal in', tone: 'text-primary' },
  accepted: { label: 'Accepted', tone: 'text-success' },
  declined: { label: 'Declined', tone: 'text-muted-foreground' },
};

function deriveInitials(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/**
 * Static observer "Pipeline health" panel — a READ-ONLY list of the request's
 * live relationships (expert name + derived stage). Invite/remove are disabled
 * placeholders: A4 (admin triage) wires invite, A5 wires removal. Rendered only
 * once the request has relationships (the page hides it before `experts_invited`).
 */
export function AdminHealthPanel({
  relationships,
}: Readonly<AdminHealthPanelProps>): React.JSX.Element {
  return (
    <RequestCard className="p-5">
      <div className="text-info mb-3 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-[11px] font-bold tracking-wider uppercase">Pipeline health</span>
      </div>

      <ul className="flex flex-col gap-2">
        {relationships.map((rel) => {
          const meta = STAGE_META[rel.status] ?? {
            label: rel.status,
            tone: 'text-muted-foreground',
          };
          return (
            <li
              key={rel.id}
              className="border-border flex items-center gap-2.5 rounded-xl border px-3 py-2.5"
            >
              <span className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold">
                {deriveInitials(rel.expertName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{rel.expertName}</p>
                <p className={cn('mt-0.5 text-xs font-medium', meta.tone)}>{meta.label}</p>
              </div>
              {/* Remove — disabled placeholder (A5 wires). */}
              <button
                type="button"
                disabled
                aria-label={`Remove ${rel.expertName}`}
                className="border-border bg-card text-muted-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      {/* Invite — disabled placeholder (A4 wires). */}
      <button
        type="button"
        disabled
        className="border-border text-muted-foreground mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-sm font-medium opacity-60"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Invite another expert
      </button>
    </RequestCard>
  );
}
