'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface WorkHistoryEntry {
  id?: string;
  role: string;
  company: string;
  startedAt: string;
  endedAt?: string;
  isCurrent: boolean;
  responsibilities?: string;
}

interface WorkHistoryCardProps {
  entry: WorkHistoryEntry;
  onEdit: () => void;
  onDelete: () => void;
}

function formatDateRange(startedAt: string, endedAt?: string, isCurrent?: boolean): string {
  const start = new Date(startedAt);
  const startStr = start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  if (isCurrent) return `${startStr} - Present`;
  if (!endedAt) return startStr;
  const end = new Date(endedAt);
  const endStr = end.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return `${startStr} - ${endStr}`;
}

function calculateDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} yr${years !== 1 ? 's' : ''}`);
  if (remainingMonths > 0) parts.push(`${remainingMonths} mo`);
  return parts.length > 0 ? parts.join(' ') : '< 1 mo';
}

export function WorkHistoryCard({
  entry,
  onEdit,
  onDelete,
}: WorkHistoryCardProps): React.JSX.Element {
  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="border-border rounded-xl border p-5"
    >
      <div className="flex items-start justify-between">
        <p className="text-foreground text-base font-semibold">{entry.role}</p>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onEdit}
            aria-label={`Edit ${entry.role} at ${entry.company}`}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive h-8 w-8"
            onClick={onDelete}
            aria-label={`Delete ${entry.role} at ${entry.company}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">{entry.company}</span>
        <span className="text-muted-foreground/40" aria-hidden="true">
          &middot;
        </span>
        <span className="text-muted-foreground text-xs">
          {formatDateRange(entry.startedAt, entry.endedAt, entry.isCurrent)}
        </span>
        <Badge variant="outline" className="bg-muted text-muted-foreground rounded-full text-xs">
          ({calculateDuration(entry.startedAt, entry.endedAt)})
        </Badge>
        {entry.isCurrent && (
          <Badge variant="outline" className="border-success/30 bg-success/10 text-success text-xs">
            Current
          </Badge>
        )}
      </div>
      {entry.responsibilities && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{entry.responsibilities}</p>
      )}
    </motion.div>
  );
}
