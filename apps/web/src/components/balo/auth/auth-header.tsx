import { Logo } from '@/components/layout/logo';
import { cn } from '@/lib/utils';

interface AuthHeaderProps {
  title: string;
  subtitle: string;
  className?: string;
}

export function AuthHeader({
  title,
  subtitle,
  className,
}: Readonly<AuthHeaderProps>): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      {/* The icon mark, not the wordmark — this sits directly above a title like "Welcome
          back", and the full wordmark would compete with it for the same line of attention. */}
      <Logo asLink={false} iconOnly height={32} className="mb-2" />
      <h2 className="text-foreground text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">{subtitle}</p>
    </div>
  );
}
