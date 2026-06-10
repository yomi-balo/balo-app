import { cn } from '@/lib/utils';

interface InitialsAvatarProps {
  initials: string;
  /** `sm` = tab strip (22px); `md` = thread header (36px). */
  size?: 'sm' | 'md';
  className?: string;
}

/** Tiny initials avatar for the conversation chrome (no image URLs hydrated here). */
export function InitialsAvatar({
  initials,
  size = 'sm',
  className,
}: Readonly<InitialsAvatarProps>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-primary/10 text-primary flex shrink-0 items-center justify-center rounded-full font-semibold',
        size === 'sm' ? 'h-[22px] w-[22px] text-[10px]' : 'h-9 w-9 text-xs',
        className
      )}
    >
      {initials}
    </span>
  );
}
