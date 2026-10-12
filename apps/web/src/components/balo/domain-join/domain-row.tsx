import { Globe } from 'lucide-react';
import type { PartyDomainForSettings } from '@balo/db';

interface DomainRowProps {
  row: PartyDomainForSettings;
  /** True when this row is the first in the list to name its capturing person. */
  firstMention: boolean;
  partyName: string;
}

const UNNAMED_PERSON = 'a teammate';

/**
 * Retrospective attribution for a read-only domain row. A signup-captured row names the person
 * who signed up, with "@ {party}" on their first mention in the list and bare after; a
 * Balo-added row names no one — staff identity never reaches a party surface.
 */
export function attributionText(
  attribution: PartyDomainForSettings['attribution'],
  firstMention: boolean,
  partyName: string
): string {
  if (attribution.kind === 'balo') return 'Added by Balo';
  const suffix = firstMention && attribution.name !== null ? ` @ ${partyName}` : '';
  return `Added automatically when ${attribution.name ?? UNNAMED_PERSON}${suffix} signed up`;
}

export function DomainRow({
  row,
  firstMention,
  partyName,
}: Readonly<DomainRowProps>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex h-9 w-9 flex-none items-center justify-center rounded-lg"
      >
        <Globe className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-semibold [overflow-wrap:anywhere]">
          {row.domain}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {attributionText(row.attribution, firstMention, partyName)}
        </p>
      </div>
    </div>
  );
}
