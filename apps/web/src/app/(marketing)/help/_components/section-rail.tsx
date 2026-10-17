'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { jumpToSection } from './jump-to-section';

export interface GuideStep {
  n: number;
  title: string;
}

interface SectionRailProps {
  slug: string;
  steps: readonly GuideStep[];
}

const ITEM_HEIGHT = 44;

/** Sticky table of contents for a guide, with a scroll-spy that follows the section being read. */
export function SectionRail({ slug, steps }: Readonly<SectionRailProps>): React.JSX.Element {
  const [active, setActive] = useState(1);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const n = Number(entry.target.dataset.step);
          if (entry.isIntersecting && Number.isFinite(n)) setActive(n);
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );
    for (const step of steps) {
      const el = document.getElementById(`step-${step.n}`);
      if (el !== null) observer.observe(el);
    }
    // The last section can be too short to reach the observer band; at the page bottom it wins.
    const lastStep = steps.at(-1);
    const handleScroll = (): void => {
      const atBottom =
        globalThis.innerHeight + globalThis.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom && lastStep !== undefined) setActive(lastStep.n);
    };
    globalThis.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('scroll', handleScroll);
    };
  }, [steps]);

  const handleJump = useCallback(
    (n: number) => {
      setActive(n);
      jumpToSection(slug, n);
    },
    [slug]
  );

  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.n === active)
  );

  return (
    <nav
      aria-label="Sections in this guide"
      className="sticky top-24 hidden w-[216px] shrink-0 self-start pt-1 lg:block"
    >
      <div className="text-muted-foreground mb-3.5 text-[13px] font-semibold">In this guide</div>
      <div className="relative">
        <span
          aria-hidden="true"
          className="bg-line absolute top-3 left-[11px] w-0.5 rounded-sm"
          style={{ height: Math.max(0, steps.length - 1) * ITEM_HEIGHT }}
        />
        <span
          aria-hidden="true"
          className="absolute top-3 left-[11px] w-0.5 rounded-sm transition-[height] duration-300 [background:linear-gradient(180deg,var(--primary),var(--violet))] motion-reduce:transition-none"
          style={{ height: activeIndex * ITEM_HEIGHT }}
        />
        <ol className="relative m-0 list-none p-0">
          {steps.map((step, index) => {
            const on = index === activeIndex;
            const done = index < activeIndex;
            return (
              <li key={step.n} style={{ height: ITEM_HEIGHT }}>
                <button
                  type="button"
                  aria-current={on ? 'location' : undefined}
                  onClick={() => handleJump(step.n)}
                  className="focus-visible:ring-ring group flex w-full items-start gap-3 rounded-md p-0 text-left outline-none focus-visible:ring-2"
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold tabular-nums transition-colors motion-reduce:transition-none',
                      on && 'text-primary-foreground [background:var(--grad)]',
                      !on && 'bg-background border-[1.5px]',
                      done && 'border-primary text-primary',
                      !on && !done && 'border-line text-muted-foreground'
                    )}
                  >
                    {step.n}
                  </span>
                  <span
                    title={step.title}
                    className={cn(
                      'group-hover:text-foreground truncate text-[13.5px] leading-6',
                      on ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium'
                    )}
                  >
                    {step.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
