import { AlertCircle, Check, Clock, PenLine, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
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

/** The read-only body of a Your move card: one shape per context type. */
export function MoveCardContext({
  context,
}: Readonly<{ context: YourMoveContext }>): React.JSX.Element {
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
      return <Gates context={context} />;
    case 'delivery':
      return <Delivery context={context} />;
    case 'items':
      return <Items context={context} />;
  }
}
