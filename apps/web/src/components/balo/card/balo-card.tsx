import { cn } from '@/lib/utils';

export type BaloCardEmphasis = 'default' | 'highlight';

/**
 * The one Balo card surface: a bordered `bg-card` panel, flat by design (BAL-618). Radius is
 * overridable through `className`. Use {@link baloCardClassName} for `motion.*` elements or tags
 * outside `as`. It takes no ref: ref-bearing elements use `baloCardClassName`.
 */
export function baloCardClassName(emphasis: BaloCardEmphasis = 'default'): string {
  return cn(
    'bg-card rounded-2xl border',
    emphasis === 'highlight' ? 'border-primary/40' : 'border-border'
  );
}

interface BaloCardProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  'className' | 'dangerouslySetInnerHTML'
> {
  as?: 'div' | 'section' | 'article';
  emphasis?: BaloCardEmphasis;
  className?: string;
  children?: React.ReactNode;
}

export function BaloCard({
  as: Tag = 'div',
  emphasis = 'default',
  className,
  children,
  ...rest
}: Readonly<BaloCardProps>): React.JSX.Element {
  return (
    <Tag className={cn(baloCardClassName(emphasis), className)} {...rest}>
      {children}
    </Tag>
  );
}
