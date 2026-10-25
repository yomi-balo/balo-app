import { BaloCard } from '@/components/balo/card/balo-card';

interface RequestCardProps {
  children: React.ReactNode;
  /** Primary-tinted border (the prototype's `glow` card). */
  glow?: boolean;
  className?: string;
}

/**
 * Request-detail card: a thin wrapper over {@link BaloCard}. Every card on the request-detail
 * page composes this so the surface stays consistent in light + dark mode. `glow` swaps the
 * border for the primary-tinted highlight.
 */
export function RequestCard({
  children,
  glow = false,
  className,
}: Readonly<RequestCardProps>): React.JSX.Element {
  return (
    <BaloCard emphasis={glow ? 'highlight' : 'default'} className={className}>
      {children}
    </BaloCard>
  );
}
