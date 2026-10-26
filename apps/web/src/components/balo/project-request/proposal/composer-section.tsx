import { cn } from '@/lib/utils';

interface ComposerSectionProps {
  /** DOM id of the section, e.g. `proposal-section-overview`. The heading id derives from it. */
  id: string;
  title: string;
  optional?: boolean;
  help?: React.ReactNode;
  /** Trailing slot of the heading row. */
  aside?: React.ReactNode;
  /** The section's content is still being produced (sets `aria-busy`). */
  busy?: boolean;
  children: React.ReactNode;
}

/**
 * One block of the single-page composer: an `h2` heading row (title, optional tag,
 * trailing `aside`), a muted help line, then the section body. The `<section>` is
 * labelled by its heading and offsets scroll jumps below the sticky header.
 */
export function ComposerSection({
  id,
  title,
  optional = false,
  help,
  aside,
  busy = false,
  children,
}: Readonly<ComposerSectionProps>): React.JSX.Element {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      className="scroll-mt-24 pt-11 first:pt-0"
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3',
          help === undefined && 'mb-3.5'
        )}
      >
        <h2
          id={headingId}
          className="text-foreground flex items-baseline gap-2 text-lg font-semibold tracking-tight"
        >
          {title}
          {optional && (
            <small className="text-muted-foreground text-[13px] font-normal">Optional</small>
          )}
        </h2>
        {aside !== undefined && <div className="flex items-center gap-3">{aside}</div>}
      </div>
      {help !== undefined && <p className="text-muted-foreground mt-1 mb-3.5 text-sm">{help}</p>}
      {children}
    </section>
  );
}
