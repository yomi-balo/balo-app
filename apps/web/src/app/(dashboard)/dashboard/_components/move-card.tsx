import Link from 'next/link';
import { BaloCard } from '@/components/balo/card/balo-card';
import {
  Briefcase,
  CalendarClock,
  CalendarX2,
  CheckCircle2,
  Compass,
  CreditCard,
  FileText,
  Handshake,
  ListChecks,
  Mail,
  MessageSquare,
  PenLine,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardYourMoveCardKind, DashboardYourMoveTarget } from '@balo/analytics/events';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ViewerClock } from '@/hooks/use-viewer-clock';
import { formatYourMoveFactAt } from '../_lib/your-move-dates';
import {
  YOUR_MOVE_KIND_META,
  type YourMoveCardView,
  type YourMoveTone,
} from '../_lib/your-move-view-types';
import { MoveCardContext } from './move-card-context';

const KIND_ICON: Record<DashboardYourMoveCardKind, LucideIcon> = {
  calendar_reconnect: CalendarX2,
  invitation: Mail,
  eoi_followup: Handshake,
  proposal_requested: PenLine,
  changes_requested: PenLine,
  delivery_changes: Briefcase,
  action_items: ListChecks,
  messages: MessageSquare,
  receivable: CreditCard,
  reschedule: CalendarClock,
  completion: CheckCircle2,
  kickoff_billing: Handshake,
  kickoff_payment: Handshake,
  exploratory_call: Compass,
  eoi_reply: Users,
  proposal_review: FileText,
  join_requests: UserPlus,
};

const TONE_CLASSES: Record<YourMoveTone, { tile: string; label: string; band: string }> = {
  warning: {
    tile: 'bg-warning/10 text-warning-strong',
    label: 'text-warning-strong',
    band: 'bg-warning',
  },
  violet: { tile: 'bg-violet/10 text-violet', label: 'text-violet', band: 'bg-violet' },
  primary: { tile: 'bg-primary/10 text-primary', label: 'text-primary', band: 'bg-primary' },
  slate: {
    tile: 'bg-muted-foreground/10 text-muted-foreground',
    label: 'text-muted-foreground',
    band: 'bg-muted-foreground',
  },
};

function factText(card: YourMoveCardView, clock: ViewerClock | null): React.ReactNode {
  if (card.fact !== null) return card.fact;
  if (card.factAt === null) return '';
  if (clock === null) return <span aria-hidden="true">&nbsp;</span>;
  return formatYourMoveFactAt(card.factAt, clock.timeZone);
}

interface MoveCardProps {
  readonly card: YourMoveCardView;
  readonly featured: boolean;
  /** The viewer's device clock; null until it resolves, so dated facts render nothing server-side. */
  readonly clock: ViewerClock | null;
  readonly onNavigate: (target: DashboardYourMoveTarget) => void;
}

export function MoveCard({
  card,
  featured,
  clock,
  onNavigate,
}: Readonly<MoveCardProps>): React.JSX.Element {
  const meta = YOUR_MOVE_KIND_META[card.kind];
  const tone = TONE_CLASSES[meta.tone];
  const Icon = KIND_ICON[card.kind];
  const blocker = meta.tier === 0;
  const ticket = card.kind === 'invitation';

  return (
    <li
      aria-label={`${meta.label}: ${card.title}`}
      data-kind={card.kind}
      data-featured={featured ? 'true' : undefined}
      className="flex shrink-0 snap-start"
    >
      <BaloCard
        as="article"
        emphasis={featured ? 'highlight' : 'default'}
        className={cn(
          'relative flex w-[292px] shrink-0 flex-col overflow-hidden rounded-[14px]',
          featured ? 'sm:w-[384px]' : 'sm:w-[300px]',
          blocker && 'border-warning/35'
        )}
      >
        <span
          aria-hidden="true"
          className={cn('h-1 shrink-0', blocker ? 'bg-warning' : tone.band)}
        />
        <div className="flex flex-1 flex-col gap-3 px-4 pt-3.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-lg',
                tone.tile
              )}
            >
              <Icon className="size-[15px]" />
            </span>
            <span className={cn('text-xs font-semibold', tone.label)}>{meta.label}</span>
          </div>
          <div>
            <h3
              className={cn(
                'text-foreground line-clamp-2 leading-snug font-semibold tracking-tight',
                featured ? 'text-[17px]' : 'text-[15.5px]'
              )}
            >
              <Link
                href={card.href}
                tabIndex={-1}
                onClick={() => onNavigate('card')}
                className="focus-visible:ring-ring rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                {card.title}
              </Link>
            </h3>
            <p className="text-muted-foreground mt-[3px] truncate text-[13px]">
              {card.counterparty}
            </p>
          </div>
          {card.context !== null && (
            <MoveCardContext
              context={card.context}
              href={card.href}
              clock={clock}
              onNavigate={onNavigate}
            />
          )}
        </div>
        <div
          className={cn(
            'border-border relative mt-3.5 flex items-center justify-between gap-2.5 px-4 pt-3 pb-3.5',
            ticket ? 'border-t-[1.5px] border-dashed' : 'border-t'
          )}
        >
          {ticket && (
            <>
              <span
                aria-hidden="true"
                className="bg-primary/5 border-primary/15 absolute -top-[9px] -left-[9px] size-4 rounded-full border"
              />
              <span
                aria-hidden="true"
                className="bg-primary/5 border-primary/15 absolute -top-[9px] -right-[9px] size-4 rounded-full border"
              />
            </>
          )}
          <span
            className={cn(
              'min-w-0 text-xs',
              card.factTone === 'warning'
                ? 'text-warning-strong font-semibold'
                : 'text-muted-foreground font-medium'
            )}
          >
            {factText(card, clock)}
          </span>
          <Button
            asChild
            size="sm"
            variant={blocker || featured ? 'default' : 'outline'}
            className="min-h-11 shrink-0"
          >
            <Link href={card.href} onClick={() => onNavigate('action')}>
              {card.actionLabel}
            </Link>
          </Button>
        </div>
      </BaloCard>
    </li>
  );
}
