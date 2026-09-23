import { cn } from '@/lib/utils';

/**
 * The shared shell for every expert-settings section (Profile, Schedule, Calendars): one
 * bordered card, an uppercase eyebrow heading, and a soft status pill. One definition so the
 * tabs cannot drift apart visually.
 */
export function SettingsCard({
  className,
  children,
  ...rest
}: Readonly<React.ComponentProps<'section'>>): React.JSX.Element {
  return (
    <section className={cn('border-border bg-card rounded-xl border p-6', className)} {...rest}>
      {children}
    </section>
  );
}

interface SettingsEyebrowProps {
  readonly as?: 'h2' | 'h3' | 'p' | 'label';
  readonly id?: string;
  /** The control a `label` eyebrow names. Ignored by the other elements. */
  readonly htmlFor?: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}

/**
 * A section label ("IDENTITY", "WEEKLY HOURS"). A heading by default so a card is navigable;
 * `as="label"` with `htmlFor` makes it the accessible name of a single control.
 */
export function SettingsEyebrow({
  as: Tag = 'h3',
  id,
  htmlFor,
  className,
  children,
}: SettingsEyebrowProps): React.JSX.Element {
  return (
    <Tag
      id={id}
      htmlFor={Tag === 'label' ? htmlFor : undefined}
      className={cn(
        'text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase',
        className
      )}
    >
      {children}
    </Tag>
  );
}

export type SettingsStatusTone = 'success' | 'warning' | 'destructive' | 'neutral';

const STATUS_TONE_CLASSES: Record<SettingsStatusTone, string> = {
  success: 'border-success/30 bg-success/10 text-success-strong',
  warning: 'border-warning/40 bg-warning/10 text-warning-strong',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive-strong',
  neutral: 'border-border bg-muted text-foreground/75',
};

interface SettingsStatusPillProps {
  readonly tone: SettingsStatusTone;
  readonly className?: string;
  readonly children: React.ReactNode;
}

/** The soft rounded status pill ("Connected", "Verified", "Waiting on IT"). */
export function SettingsStatusPill({
  tone,
  className,
  children,
}: SettingsStatusPillProps): React.JSX.Element {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        STATUS_TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
