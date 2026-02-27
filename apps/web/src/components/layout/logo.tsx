import Link from 'next/link';
import { cn } from '@/lib/utils';

interface LogoProps {
  className?: string;
  collapsed?: boolean;
}

export function Logo({ className, collapsed = false }: LogoProps): React.JSX.Element {
  return (
    <Link
      href="/"
      className={cn(
        'text-foreground hover:text-foreground/80 flex items-center gap-2 rounded-lg font-semibold transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className
      )}
    >
      {/* Icon mark — always visible */}
      <div className="bg-primary flex h-8 w-8 items-center justify-center rounded-lg">
        <span className="text-primary-foreground text-sm font-semibold">B</span>
      </div>
      {/* Wordmark — hidden when sidebar collapsed */}
      {!collapsed && <span className="text-lg">balo</span>}
    </Link>
  );
}
