import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { CasesIndexCardView } from '../_lib/cases-index-view-types';

/**
 * BAL-567 — "{avatar} {Name}, {Org}", the one line both card shapes render.
 *
 * ⚠ EXTRACTED BECAUSE IT WAS THE ONE GENUINE DUPLICATE between `case-card.tsx` and
 * `featured-case-card.tsx` — the same twelve lines with a different avatar size, which is exactly
 * the shape SonarCloud's >3% new-code duplication gate exists to catch (memory
 * `reference_sonar_duplication_not_caught_locally`). Extracting it also means the two surfaces
 * cannot drift into naming the counterparty differently.
 *
 * ⚠ THE SIDE IS ALREADY BAKED IN. `counterpartyName` is the expert PERSON on the client side and
 * the client COMPANY on the expert side, resolved server-side by `resolveCounterparty`; this
 * component makes no such decision and must not start.
 *
 * ⚠ `alt=""` ON THE AVATAR IMAGE, DELIBERATELY. The name is rendered as text right beside it, so
 * an `alt` would make a screen reader say it twice. The initials fallback is likewise decorative.
 *
 * PURE PRESENTATIONAL: no state, no effects, no directive of its own.
 */
export function CaseCounterpartyLine({
  card,
  size,
}: Readonly<{
  card: Pick<
    CasesIndexCardView,
    'counterpartyName' | 'counterpartyOrgLabel' | 'counterpartyAvatarUrl' | 'counterpartyInitials'
  >;
  /** Tailwind size utility for the avatar, e.g. `size-5` — the two densities differ only here. */
  size: string;
}>): React.JSX.Element {
  return (
    <span className="mt-2 flex min-w-0 items-center gap-2">
      <Avatar className={size}>
        {card.counterpartyAvatarUrl !== null && (
          <AvatarImage src={card.counterpartyAvatarUrl} alt="" />
        )}
        <AvatarFallback className={cn(size === 'size-8' ? 'text-[11px]' : 'text-[9px]')}>
          {card.counterpartyInitials}
        </AvatarFallback>
      </Avatar>
      <span className="text-muted-foreground block min-w-0 truncate text-[13px]">
        <span className="text-foreground font-medium">{card.counterpartyName}</span>
        {card.counterpartyOrgLabel !== null && <span>, {card.counterpartyOrgLabel}</span>}
      </span>
    </span>
  );
}
