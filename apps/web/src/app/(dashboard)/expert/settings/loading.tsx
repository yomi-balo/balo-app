import { cn } from '@/lib/utils';

const MAIN_TAB_PLACEHOLDERS = [
  { key: 'profile', width: 'w-12' },
  { key: 'rate', width: 'w-9' },
  { key: 'schedule', width: 'w-16' },
  { key: 'payouts', width: 'w-14' },
] as const;
const SUB_TAB_PLACEHOLDERS = [
  { key: 'profile', width: 'w-12' },
  { key: 'expertise', width: 'w-16' },
  { key: 'workHistory', width: 'w-20' },
  { key: 'certifications', width: 'w-24' },
] as const;
const FORM_CARD_PLACEHOLDERS = [
  { key: 'photo', height: 'h-28' },
  { key: 'identity', height: 'h-64' },
  { key: 'public-profile', height: 'h-44' },
] as const;

/** The sub-tab strip rule, drawn the same way as the live underline strip. */
const STRIP_RULE = 'flex shadow-[inset_0_-1px_0_var(--border)]';

/**
 * The expert-settings LOADING state, mirroring the page chrome so nothing re-flows when data
 * lands: the setup banner, the pill main-tab strip and the underline sub-tab strip, then the Profile tab's two-column builder
 * (the default landing tab).
 */
export default function ExpertSettingsLoading(): React.JSX.Element {
  return (
    <output aria-label="Loading settings" className="flex flex-col gap-7">
      {/* Setup banner */}
      <span className="bg-muted block h-[46px] animate-pulse rounded-[10px]" />

      <span className="block">
        {/* Main tab strip (pill) */}
        <span className="mb-6 block">
          <span
            data-testid="main-tab-pill"
            className="bg-muted inline-flex max-w-full gap-1 rounded-xl p-1"
          >
            {MAIN_TAB_PLACEHOLDERS.map(({ key, width }) => (
              <span key={key} className="flex items-center gap-1.5 px-4 py-3 sm:py-2">
                <span className="bg-background/70 block size-4 animate-pulse rounded" />
                <span className={cn('bg-background/70 block h-4 animate-pulse rounded', width)} />
              </span>
            ))}
          </span>
        </span>

        {/* Profile sub-tab strip */}
        <span className={cn(STRIP_RULE, 'mb-6 gap-5')}>
          {SUB_TAB_PLACEHOLDERS.map(({ key, width }) => (
            <span key={key} className="px-0.5 py-3 sm:py-2">
              <span className={cn('bg-muted/70 block h-4 animate-pulse rounded', width)} />
            </span>
          ))}
        </span>

        {/* Profile builder: form cards + preview column */}
        <span className="grid items-start gap-7 lg:grid-cols-[1.75fr_1fr]">
          <span className="flex flex-col gap-[22px]">
            {FORM_CARD_PLACEHOLDERS.map(({ key, height }) => (
              <span
                key={key}
                className={cn(
                  'border-border bg-card block animate-pulse rounded-xl border',
                  height
                )}
              />
            ))}
          </span>
          <span className="border-border bg-card hidden h-80 animate-pulse rounded-xl border lg:block" />
        </span>
      </span>
      <span className="sr-only">Loading…</span>
    </output>
  );
}
