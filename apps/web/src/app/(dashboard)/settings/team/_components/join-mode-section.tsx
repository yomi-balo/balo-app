'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/balo/domain-join/section-states';
import { formatShortDate } from '@/components/balo/domain-join/format';
import { setCompanyJoinMode } from '../_actions/set-join-mode';
import { cn } from '@/lib/utils';

type JoinMode = 'auto' | 'request' | 'off';

interface JoinModeSectionProps {
  companyId: string;
  initialMode: JoinMode;
  lastChangedByName: string | null;
  lastChangedAt: Date | null;
}

const MODE_OPTIONS: ReadonlyArray<{
  value: JoinMode;
  title: string;
  description: string;
  isDefault?: boolean;
}> = [
  {
    value: 'auto',
    title: 'Automatic',
    isDefault: true,
    description: 'Anyone who signs up with a verified company domain joins right away.',
  },
  {
    value: 'request',
    title: 'Request to join',
    description: 'People with your domain ask to join, and an admin approves each one below.',
  },
  {
    value: 'off',
    title: 'Off',
    description: 'No one joins by domain. You add members yourself by invitation.',
  },
];

interface ModeOptionProps {
  option: (typeof MODE_OPTIONS)[number];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}

function ModeOption({
  option,
  selected,
  disabled,
  onSelect,
}: Readonly<ModeOptionProps>): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        selected
          ? 'border-primary/55 bg-primary/5 ring-primary/10 ring-2'
          : 'border-border hover:bg-muted/40'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid h-4.5 w-4.5 flex-none place-items-center rounded-full border-2',
          selected ? 'border-primary' : 'border-border'
        )}
      >
        {selected && <span className="bg-primary h-2 w-2 rounded-full" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-foreground text-sm font-semibold">{option.title}</span>
          {option.isDefault && (
            <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
              Default
            </span>
          )}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
          {option.description}
        </span>
      </span>
    </button>
  );
}

/**
 * Join-mode radio-cards (BAL-347, COMPANY ONLY). Optimistically applies the chosen
 * mode, calls the company-scoped Server Action, toasts on success, and rolls back +
 * toasts on failure. The "Last changed by … · date" line is powered by a real audit
 * read. Never imports agency concepts — this component is company-only by placement.
 */
export function JoinModeSection({
  companyId,
  initialMode,
  lastChangedByName,
  lastChangedAt,
}: Readonly<JoinModeSectionProps>): React.JSX.Element {
  const [mode, setMode] = useState<JoinMode>(initialMode);
  const [isBusy, setIsBusy] = useState(false);

  const choose = useCallback(
    async (next: JoinMode): Promise<void> => {
      if (next === mode || isBusy) return;
      const previous = mode;
      setMode(next);
      setIsBusy(true);
      try {
        const result = await setCompanyJoinMode({ companyId, mode: next });
        if (result.success) {
          toast.success('Join mode updated');
        } else {
          setMode(previous);
          toast.error(result.error);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [mode, isBusy, companyId]
  );

  const headerRight =
    lastChangedByName === null ? undefined : (
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        Last changed by {lastChangedByName}
        {lastChangedAt === null ? '' : ` · ${formatShortDate(lastChangedAt)}`}
      </span>
    );

  return (
    <SectionCard
      title="Join mode"
      description="How people with your domain become members. This choice is recorded in your audit log."
      headerRight={headerRight}
    >
      <div role="radiogroup" aria-label="Join mode" className="flex flex-col gap-2.5">
        {MODE_OPTIONS.map((option) => (
          <ModeOption
            key={option.value}
            option={option}
            selected={mode === option.value}
            disabled={isBusy}
            onSelect={() => {
              choose(option.value).catch(() => undefined);
            }}
          />
        ))}
      </div>
    </SectionCard>
  );
}
