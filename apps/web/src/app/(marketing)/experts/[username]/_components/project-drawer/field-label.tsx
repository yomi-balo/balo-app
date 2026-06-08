import { cn } from '@/lib/utils';

interface FieldLabelProps {
  children: React.ReactNode;
  /** Appends a muted "(optional)" suffix. */
  optional?: boolean;
  /** Associates the label with its control. */
  htmlFor?: string;
  className?: string;
}

/**
 * Label-above field heading used across the project-drawer form. Semibold
 * foreground text with an optional muted "(optional)" suffix.
 */
export function FieldLabel({
  children,
  optional,
  htmlFor,
  className,
}: Readonly<FieldLabelProps>): React.JSX.Element {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-foreground block text-sm font-semibold', className)}
    >
      {children}
      {optional && <span className="text-muted-foreground font-medium"> (optional)</span>}
    </label>
  );
}
