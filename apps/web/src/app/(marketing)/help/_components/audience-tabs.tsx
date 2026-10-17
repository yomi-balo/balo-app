'use client';

import { useCallback, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { HELP_AUDIENCES, type HelpAudience } from '@/lib/analytics';
import { cn } from '@/lib/utils';

interface AudienceTabsProps {
  audience: HelpAudience;
  onChange: (next: HelpAudience) => void;
}

interface TabSpec {
  title: string;
  sub: string;
  tone: string;
  subTone: string;
}

const TABS: Readonly<Record<HelpAudience, TabSpec>> = {
  client: {
    title: 'I’m hiring experts',
    sub: 'Booking consultations, running projects, credit and billing.',
    tone: 'bg-mist border-line text-foreground',
    subTone: 'text-muted-foreground',
  },
  expert: {
    title: 'I work as an expert',
    sub: 'Getting approved, getting booked, delivering projects and getting paid.',
    tone: 'bg-night border-night text-night-foreground',
    subTone: 'text-night-foreground/75',
  },
};

const KEY_TARGETS: Readonly<Record<string, HelpAudience | 'toggle'>> = {
  ArrowLeft: 'toggle',
  ArrowRight: 'toggle',
  ArrowUp: 'toggle',
  ArrowDown: 'toggle',
  Home: 'client',
  End: 'expert',
};

/** The client / expert side switch: a two-tab tablist that controls the panel below it. */
export function AudienceTabs({
  audience,
  onChange,
}: Readonly<AudienceTabsProps>): React.JSX.Element {
  const refs = useRef<Partial<Record<HelpAudience, HTMLButtonElement | null>>>({});

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const target = KEY_TARGETS[event.key];
      if (target === undefined) return;
      event.preventDefault();
      const other: HelpAudience = audience === 'client' ? 'expert' : 'client';
      const next = target === 'toggle' ? other : target;
      onChange(next);
      refs.current[next]?.focus();
    },
    [audience, onChange]
  );

  return (
    <div
      role="tablist"
      aria-label="Who the guides are for"
      className="flex flex-col gap-2 md:flex-row md:gap-3"
    >
      {HELP_AUDIENCES.map((key) => {
        const spec = TABS[key];
        const selected = key === audience;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[key] = el;
            }}
            type="button"
            role="tab"
            id={`help-tab-${key}`}
            aria-selected={selected}
            aria-controls="help-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(key)}
            onKeyDown={handleKeyDown}
            className={cn(
              'group focus-visible:ring-ring relative flex basis-0 flex-col justify-end overflow-hidden rounded-[18px] border text-left outline-none focus-visible:ring-2 focus-visible:ring-offset-2 md:min-h-[172px] md:p-7 md:pb-8',
              'transition-[flex-grow] duration-300 motion-reduce:transition-none',
              spec.tone,
              selected
                ? 'cursor-default px-5 pt-5 pb-6 md:grow-[1.7]'
                : 'cursor-pointer px-5 py-4 md:grow'
            )}
          >
            <span
              className={cn(
                'flex items-center gap-2 leading-tight font-bold tracking-tight transition-[font-size] duration-300 motion-reduce:transition-none',
                selected
                  ? 'text-[22px] md:text-[30px]'
                  : 'text-base underline-offset-4 group-hover:underline md:text-xl'
              )}
            >
              {spec.title}
              {selected ? null : (
                <ChevronRight aria-hidden="true" className="size-4 md:size-[18px]" />
              )}
            </span>
            {selected ? (
              <span className={cn('mt-2.5 max-w-[420px] text-[15px] leading-normal', spec.subTone)}>
                {spec.sub}
              </span>
            ) : null}
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-1 [background:var(--grad)]"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
