'use client';

import { Users, Lock, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ClientRequestFileAudience } from '@/lib/request-files/request-file-audience-view';

/**
 * The mirrored decline/not-selected annotation copy (Ruling 2, §12). ONE flat lookup rather
 * than a nested ternary (SonarCloud S3358) — four combinations, four literal strings.
 */
function annotationText(
  reason: 'declined' | 'not_selected',
  trackName: string,
  keptAccess: boolean
): string {
  const COPY: Record<'declined' | 'not_selected', Record<'kept' | 'lost', string>> = {
    declined: {
      kept: `${trackName} kept access · shared before declining`,
      lost: `${trackName} declined — not shared`,
    },
    not_selected: {
      kept: `${trackName} kept access · shared before the project was awarded`,
      lost: `${trackName} wasn't selected — not shared`,
    },
  };
  return COPY[reason][keptAccess ? 'kept' : 'lost'];
}

interface RequestFileAudienceBadgesProps {
  audience: ClientRequestFileAudience;
  onRevoke: (relationshipId: string, trackName: string) => void;
  revokingRelationshipId: string | null;
}

/**
 * BAL-431 / ADR-1048 §3 — audience badges. Renders ONLY on the client and admin views; it is
 * structurally absent from the expert view (the expert view type has no field to feed it —
 * `request-file-audience-view.ts`'s concealment proof).
 */
export function RequestFileAudienceBadges({
  audience,
  onRevoke,
  revokingRelationshipId,
}: Readonly<RequestFileAudienceBadgesProps>): React.JSX.Element {
  if (audience.type === 'expert_own_track') {
    return (
      <Badge variant="secondary" className="gap-1 text-xs font-medium">
        <Lock className="h-2.5 w-2.5" aria-hidden="true" />
        Their conversation only
      </Badge>
    );
  }

  if (audience.type === 'all_live_tracks') {
    return (
      <>
        <Badge className="gap-1 bg-blue-50 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:bg-blue-950 dark:text-blue-300">
          <Users className="h-2.5 w-2.5" aria-hidden="true" />
          Everyone invited · {audience.liveTrackCount} live
        </Badge>
        {audience.annotations.map((a) => (
          <span key={a.relationshipId} className="text-muted-foreground text-xs">
            {annotationText(a.reason, a.trackName, a.keptAccess)}
          </span>
        ))}
      </>
    );
  }

  // audience.type === 'grants'
  if (audience.grants.length === 0) {
    return (
      <Badge variant="secondary" className="text-muted-foreground text-xs">
        No experts have access
      </Badge>
    );
  }
  return (
    <>
      {audience.grants.map((g) => (
        <Badge
          key={g.relationshipId}
          className="gap-1 bg-violet-50 text-xs font-medium text-violet-700 hover:bg-violet-50 dark:bg-violet-950 dark:text-violet-300"
        >
          {g.trackName} only
          {/*
            ⚠ 44px HIT AREA FROM A 10px GLYPH. The visible affordance stays badge-sized, but the
            touchable box is expanded to the 44×44 minimum with a negative margin so it does not
            change the badge's layout. Without it the target was ~14px — unhittable with a thumb
            on a row of grant badges, and revoke is a silent, unnotified access change.
          */}
          <button
            type="button"
            onClick={() => onRevoke(g.relationshipId, g.trackName)}
            disabled={revokingRelationshipId === g.relationshipId}
            aria-label={`Remove access for ${g.trackName}`}
            className="focus-visible:ring-ring -my-3 -mr-2 flex h-11 w-11 items-center justify-center rounded-full hover:bg-violet-100 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 dark:hover:bg-violet-900"
          >
            <X className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        </Badge>
      ))}
    </>
  );
}
