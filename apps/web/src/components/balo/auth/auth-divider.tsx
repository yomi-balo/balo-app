import { cn } from '@/lib/utils';

interface AuthDividerProps {
  className?: string;
}

export function AuthDivider({ className }: AuthDividerProps): React.JSX.Element {
  return (
    <div className={cn('relative flex items-center py-1', className)}>
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground bg-background px-3 text-xs tracking-wider uppercase">
        or continue with
      </span>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}
