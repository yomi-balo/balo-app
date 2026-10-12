import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { ConflictOwnerView } from '../_lib/staff-domain-types';
import {
  conflictConsequenceSentence,
  conflictOwnerSentence,
  lookupHrefForParty,
} from '../_lib/staff-domain-view';

interface ConflictPanelProps {
  domain: string;
  owner: ConflictOwnerView;
  targetName: string;
}

/**
 * Shown when the domain a staffer is adding already belongs to another party. States who owns it
 * and that a reassign moves the domain only — existing members stay where they are.
 */
export function ConflictPanel({
  domain,
  owner,
  targetName,
}: Readonly<ConflictPanelProps>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Domain already in use"
      className="bg-warning/10 border-warning/30 flex items-start gap-2.5 rounded-xl border px-3.5 py-3"
    >
      <AlertTriangle className="text-warning mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <div className="text-foreground space-y-1.5 text-[13px] leading-relaxed">
        <p className="font-semibold">{`${domain} belongs to ${owner.partyName}`}</p>
        <p>{conflictOwnerSentence(owner)}</p>
        <p>{conflictConsequenceSentence(domain, owner, targetName)}</p>
        <p>
          <Link
            href={lookupHrefForParty(owner.partyName)}
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            {`View ${owner.partyName} in Lookup`}
          </Link>
        </p>
      </div>
    </div>
  );
}
