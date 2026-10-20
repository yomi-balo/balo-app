import Link from 'next/link';
import { AlertCircle, Check, ChevronRight, Clock, PenLine, Square } from 'lucide-react';
import type { DashboardYourMoveTarget } from '@balo/analytics/events';
import { cn } from '@/lib/utils';
import type { ViewerClock } from '@/hooks/use-viewer-clock';
import {
  yourMoveAutoAccepts,
  yourMoveMilestonesComplete,
  yourMoveWas,
} from '../_lib/your-move-copy';
import { formatYourMoveDay, formatYourMoveDayTime } from '../_lib/your-move-dates';
import type { YourMoveContext, YourMoveGateState } from '../_lib/your-move-view-types';

type ContextOf<T extends YourMoveContext['type']> = Extract<YourMoveContext, { type: T }>;

function Chip({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <span className="bg-muted text-muted-foreground inline-flex h-[22px] items-center rounded-md px-2 text-[11.5px] font-semibold">
      {children}
    </span>
  );
}

function Quote({ note }: Readonly<{ note: string }>): React.JSX.Element {
  return (
    <blockquote className="border-violet bg-violet/5 text-foreground/80 line-clamp-3 rounded-r-lg border-l-[3px] px-[11px] py-2 text-[13px] leading-normal">
      {note}
    </blockquote>
  );
}

function Brief({ context }: Readonly<{ context: ContextOf<'brief'> }>): React.JSX.Element {
  return (
    <div>
      {context.excerpt !== null && (
        <p className="text-foreground/80 line-clamp-3 text-[13px] leading-normal">
          {context.excerpt}
        </p>
      )}
      {context.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {context.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      )}
      {context.timeline !== null && (
        <p className="text-muted-foreground mt-2.5 flex items-center gap-1.5 text-xs">
          <Clock className="size-[13px]" aria-hidden="true" />
          {context.timeline}
        </p>
      )}
    </div>
  );
}

function Message({ context }: Readonly<{ context: ContextOf<'message'> }>): React.JSX.Element {
  return (
    <div className="bg-background border-border rounded-[4px_12px_12px_12px] border px-3 py-2.5">
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-foreground truncate font-semibold">{context.from}</span>
        {context.at !== null && (
          <span className="text-muted-foreground whitespace-nowrap">{context.at}</span>
        )}
      </div>
      <p className="text-foreground/80 mt-1 line-clamp-2 text-[13px] leading-snug">
        {context.snippet}
      </p>
    </div>
  );
}

const GATE_SR: Record<YourMoveGateState, string> = {
  done: ', done',
  yours: ', waiting on you',
  pending: ', not yet',
};

function Gates({ context }: Readonly<{ context: ContextOf<'gates'> }>): React.JSX.Element {
  return (
    <ol aria-label="Kickoff gates" className="mt-0.5 flex list-none p-0">
      {context.gates.map((gate, i) => {
        const done = gate.state === 'done';
        const yours = gate.state === 'yours';
        const previousDone = context.gates[i - 1]?.state === 'done';
        return (
          <li key={gate.label} className="relative flex-1 text-center">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-[11px] right-1/2 h-0.5 w-full',
                  previousDone ? 'bg-success' : 'bg-border'
                )}
              />
            )}
            <span
              className={cn(
                'relative z-10 inline-flex size-6 items-center justify-center rounded-full',
                done ? 'bg-success text-success-foreground' : 'bg-card border-2',
                !done && (yours ? 'border-primary' : 'border-border')
              )}
            >
              {done && <Check className="size-3.5" aria-hidden="true" />}
              {yours && <span aria-hidden="true" className="bg-primary size-2 rounded-full" />}
            </span>
            <span
              className={cn(
                'mt-[5px] block text-[11.5px]',
                yours ? 'text-primary font-semibold' : 'text-muted-foreground font-medium'
              )}
            >
              {gate.label}
              <span className="sr-only">{GATE_SR[gate.state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function GatesWithNote({ context }: Readonly<{ context: ContextOf<'gates'> }>): React.JSX.Element {
  return (
    <div>
      <Gates context={context} />
      {context.note !== null && (
        <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-snug">{context.note}</p>
      )}
    </div>
  );
}

function Delivery({ context }: Readonly<{ context: ContextOf<'delivery'> }>): React.JSX.Element {
  const pct = context.total > 0 ? Math.round((context.done / context.total) * 100) : 0;
  return (
    <div>
      <Quote note={context.note} />
      <div aria-hidden="true" className="bg-muted mt-3 h-1.5 overflow-hidden rounded-full">
        <div className="bg-violet h-full" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-muted-foreground mt-1.5 text-[12.5px]">
        {context.done} of {context.total} milestones
      </p>
    </div>
  );
}

function Items({ context }: Readonly<{ context: ContextOf<'items'> }>): React.JSX.Element {
  return (
    <ul className="flex list-none flex-col gap-[7px] p-0">
      {context.items.map((item, index) => (
        <li
          key={`${index}-${item.text}`}
          className="text-foreground flex items-start gap-2 text-[13px]"
        >
          {item.overdue ? (
            <AlertCircle
              className="text-warning-strong mt-0.5 size-[15px] shrink-0"
              aria-hidden="true"
            />
          ) : (
            <Square
              className="text-muted-foreground mt-0.5 size-[15px] shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0">
            {item.text}
            {item.overdue && (
              <span className="text-warning-strong ml-1.5 text-[11.5px] font-semibold">
                Overdue
              </span>
            )}
          </span>
        </li>
      ))}
      {context.more > 0 && (
        <li className="text-muted-foreground pl-[23px] text-[12.5px]">{context.more} more</li>
      )}
    </ul>
  );
}

function Stats({ context }: Readonly<{ context: ContextOf<'stats'> }>): React.JSX.Element {
  return (
    <dl className="m-0 grid grid-cols-3 gap-2">
      {context.stats.map((stat) => (
        <div key={stat.label} className="bg-violet/5 rounded-[10px] px-[9px] py-2">
          <dt className="text-muted-foreground text-[11.5px]">{stat.label}</dt>
          <dd className="text-foreground m-0 mt-0.5 text-[13.5px] font-semibold">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface RescheduleProps {
  readonly context: ContextOf<'reschedule'>;
  readonly href: string;
  readonly clock: ViewerClock | null;
  readonly onNavigate: (target: DashboardYourMoveTarget) => void;
}

function Reschedule({
  context,
  href,
  clock,
  onNavigate,
}: Readonly<RescheduleProps>): React.JSX.Element {
  return (
    <div>
      <p className="text-muted-foreground mb-2 text-[12.5px] line-through">
        {clock === null ? (
          <span aria-hidden="true">&nbsp;</span>
        ) : (
          yourMoveWas(formatYourMoveDayTime(context.wasIso, clock.timeZone))
        )}
      </p>
      <div className="flex flex-col gap-1.5">
        {context.optionIsos.map((iso) =>
          clock === null ? (
            <span
              key={iso}
              aria-hidden="true"
              className="bg-primary/10 block h-11 rounded-lg motion-safe:animate-pulse"
            />
          ) : (
            <Link
              key={iso}
              href={href}
              aria-label={`Choose ${formatYourMoveDayTime(iso, clock.timeZone)} on the case page`}
              onClick={() => onNavigate('card')}
              className="bg-primary/10 text-primary focus-visible:ring-ring flex h-11 items-center justify-between rounded-lg px-[11px] text-[13px] font-semibold no-underline focus-visible:ring-2 focus-visible:outline-none"
            >
              {formatYourMoveDayTime(iso, clock.timeZone)}
              <ChevronRight className="size-[15px]" aria-hidden="true" />
            </Link>
          )
        )}
      </div>
    </div>
  );
}

function Completion({
  context,
  clock,
}: Readonly<{ context: ContextOf<'completion'>; clock: ViewerClock | null }>): React.JSX.Element {
  const pct = context.total > 0 ? Math.round((context.done / context.total) * 100) : 0;
  return (
    <div>
      <div aria-hidden="true" className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div className="bg-success h-full" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-foreground mt-2 text-[13px] font-semibold">
        {yourMoveMilestonesComplete(context.done, context.total)}
      </p>
      {context.autoAcceptIso !== null && (
        <p className="text-muted-foreground mt-0.5 min-h-4 text-[12.5px]">
          {clock === null ? (
            <span aria-hidden="true">&nbsp;</span>
          ) : (
            yourMoveAutoAccepts(formatYourMoveDay(context.autoAcceptIso, clock.timeZone))
          )}
        </p>
      )}
    </div>
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

function People({ context }: Readonly<{ context: ContextOf<'people'> }>): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {context.people.map((person) => (
        <li key={person.email} className="flex min-w-0 items-center gap-[9px]">
          <span
            aria-hidden="true"
            className="bg-violet/20 text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          >
            {initialsOf(person.name)}
          </span>
          <span className="min-w-0">
            <span className="text-foreground block truncate text-[13px] font-semibold">
              {person.name}
            </span>
            <span className="text-muted-foreground block truncate text-xs">{person.email}</span>
          </span>
        </li>
      ))}
      {context.more > 0 && (
        <li className="text-muted-foreground pl-[37px] text-[12.5px]">{context.more} more</li>
      )}
    </ul>
  );
}

interface MoveCardContextProps {
  readonly context: YourMoveContext;
  readonly href: string;
  readonly clock: ViewerClock | null;
  readonly onNavigate: (target: DashboardYourMoveTarget) => void;
}

/** The read-only body of a Your move card: one shape per context type. */
export function MoveCardContext({
  context,
  href,
  clock,
  onNavigate,
}: Readonly<MoveCardContextProps>): React.JSX.Element {
  switch (context.type) {
    case 'brief':
      return <Brief context={context} />;
    case 'sentence':
      return <p className="text-foreground/80 text-[13px] leading-normal">{context.body}</p>;
    case 'draft':
      return (
        <p className="bg-violet/5 text-violet flex items-center gap-2 rounded-[10px] px-[11px] py-[9px] text-[12.5px] font-semibold">
          <PenLine className="size-3.5" aria-hidden="true" />
          {context.label}
        </p>
      );
    case 'message':
      return <Message context={context} />;
    case 'change_note':
      return (
        <div>
          <Quote note={context.note} />
          {context.section !== null && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Chip>{context.section}</Chip>
            </div>
          )}
        </div>
      );
    case 'gates':
      return <GatesWithNote context={context} />;
    case 'delivery':
      return <Delivery context={context} />;
    case 'items':
      return <Items context={context} />;
    case 'stats':
      return <Stats context={context} />;
    case 'reschedule':
      return <Reschedule context={context} href={href} clock={clock} onNavigate={onNavigate} />;
    case 'completion':
      return <Completion context={context} clock={clock} />;
    case 'people':
      return <People context={context} />;
  }
}
