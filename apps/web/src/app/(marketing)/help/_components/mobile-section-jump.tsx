'use client';

import { useCallback, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { jumpToSection } from './jump-to-section';
import type { GuideStep } from './section-rail';

interface MobileSectionJumpProps {
  slug: string;
  steps: readonly GuideStep[];
}

/** Collapsible "In this guide" list shown below the desktop breakpoint, where the rail is hidden. */
export function MobileSectionJump({
  slug,
  steps,
}: Readonly<MobileSectionJumpProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const handleToggle = useCallback(() => setOpen((value) => !value), []);
  const handlePick = useCallback(
    (n: number) => {
      setOpen(false);
      toggleRef.current?.focus();
      jumpToSection(slug, n);
    },
    [slug]
  );

  return (
    <div className="border-line mt-6 rounded-xl border lg:hidden">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? 'help-jump' : undefined}
        onClick={handleToggle}
        className="text-foreground focus-visible:ring-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold outline-none focus-visible:ring-2"
      >
        In this guide
        <span className="text-muted-foreground flex items-center gap-1.5 font-medium">
          {steps.length} {steps.length === 1 ? 'section' : 'sections'}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-4 transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-180'
            )}
          />
        </span>
      </button>
      {open ? (
        <ol id="help-jump" className="m-0 list-none px-1.5 pt-0 pb-2">
          {steps.map((step) => (
            <li key={step.n}>
              <button
                type="button"
                onClick={() => handlePick(step.n)}
                className="text-foreground/90 hover:bg-mist focus-visible:ring-ring flex min-h-11 w-full gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm outline-none focus-visible:ring-2"
              >
                <span className="text-primary min-w-4 font-bold">{step.n}</span>
                {step.title}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
