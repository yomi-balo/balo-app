import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarRowHeaderProps {
  readonly provider: CalendarProvider;
  /** The muted second line: the account email, or the provider's sublabel. */
  readonly subline: React.ReactNode;
  /** Right-aligned controls — a status pill, the options menu, or a "Connect" action. */
  readonly children?: React.ReactNode;
}

/**
 * The header line every row in the Calendars card shares — connected accounts and the
 * not-yet-connected providers alike: a brand tile, the provider label as the row's heading,
 * a muted subline, and the row's controls on the right. The brand icon keeps its own colours
 * on a neutral tile, so both providers read the same way in light and dark mode.
 */
export function CalendarRowHeader({
  provider,
  subline,
  children,
}: Readonly<CalendarRowHeaderProps>): React.JSX.Element {
  const { label, Icon } = PROVIDER_META[provider];

  return (
    <div className="flex items-center gap-3">
      <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-lg">
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-foreground truncate text-[13.5px] leading-snug font-semibold">
          {label}
        </h3>
        <p className="text-muted-foreground truncate text-xs leading-snug">{subline}</p>
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}
