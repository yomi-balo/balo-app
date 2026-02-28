import { cn } from '@/lib/utils';

interface AuthHeaderProps {
  title: string;
  subtitle: string;
  className?: string;
}

export function AuthHeader({ title, subtitle, className }: AuthHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      {/* Logo mark */}
      <div className="bg-primary mb-2 flex h-10 w-10 items-center justify-center rounded-xl">
        <span className="text-primary-foreground text-base font-semibold">B</span>
      </div>
      <h2 className="text-foreground text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">{subtitle}</p>
    </div>
  );
}
