'use client';

import { useState } from 'react';
import { Plus, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extractEmailDomain, isBlockedDomain } from '@balo/shared/domains';
import { cn } from '@/lib/utils';

export interface GuestDraft {
  email: string;
  name?: string;
}

export interface GuestInviteComposerProps {
  guests: readonly GuestDraft[];
  onChange: (guests: readonly GuestDraft[]) => void;
  /** `booker + expert` — the composer adds `guests.length` to compute the 10-cap. */
  otherParticipantCount: number;
  /** The actor's own email domain, for the live "same company as you" disclosure. `null` if unknown. */
  viewerEmailDomain: string | null;
  /** For the "Outside {client company}" copy. `null` falls back to "your company". */
  clientCompanyName: string | null;
}

const MAX_TOTAL_PARTICIPANTS = 10;

/** True when adding this address grants CASE-level (not just this call's) access. */
function isCaseLevelAccess(email: string, viewerEmailDomain: string | null): boolean {
  const domain = extractEmailDomain(email);
  if (domain === null) return false;
  return viewerEmailDomain !== null && domain === viewerEmailDomain && !isBlockedDomain(domain);
}

/** Live, per-keystroke disclosure of what THIS address (if added) would grant — an ESTIMATE. */
function liveDisclosure(
  email: string,
  viewerEmailDomain: string | null,
  companyName: string | null
): string | null {
  const domain = extractEmailDomain(email);
  if (domain === null) return null;
  if (isCaseLevelAccess(email, viewerEmailDomain)) {
    return 'Same company as you — they’ll see this whole case, including consultations held before today.';
  }
  const company = companyName ?? 'your company';
  return `Outside ${company}, or a personal email address — they'll only see this call and its recap.`;
}

/**
 * UX-4 (BAL-400 round 2) — the PERSISTENT, post-add record of what access was actually
 * granted, distinct from `liveDisclosure`'s per-keystroke estimate (which disappears the
 * instant the draft is cleared). Design §Copy Reference — singular/plural summary disclosure.
 * `null` when no added guest resolved to case-level access.
 */
function summaryDisclosure(caseLevelGuests: readonly GuestDraft[]): string | null {
  const [only, ...rest] = caseLevelGuests;
  if (only === undefined) return null;
  if (rest.length === 0) {
    const label = only.name ?? only.email;
    return `${label} will be able to read every consultation in this case — recaps, transcripts and action items — including ones held before they were invited.`;
  }
  return `${caseLevelGuests.length} people will be able to read every consultation in this case, including ones held before they were invited.`;
}

/**
 * BAL-400 — the compact guest composer, reconciled with `guest-invitation.jsx`. Always
 * available regardless of attach/new (design §Step 2). ⚠ NO party/accessScope is ever sent —
 * the authoritative computation happens server-side at invite time (ADR-1038); this component
 * only estimates for UX.
 */
export function GuestInviteComposer({
  guests,
  onChange,
  otherParticipantCount,
  viewerEmailDomain,
  clientCompanyName,
}: Readonly<GuestInviteComposerProps>): React.JSX.Element {
  const [draftEmail, setDraftEmail] = useState('');
  const total = otherParticipantCount + guests.length;
  const atCap = total >= MAX_TOTAL_PARTICIPANTS;

  const disclosure =
    draftEmail.trim().length > 0
      ? liveDisclosure(draftEmail, viewerEmailDomain, clientCompanyName)
      : null;

  // ⚠ NOT A REGEX — a hand-rolled `local@domain.tld` pattern here trips SonarCloud's S5852
  // (regexp/no-super-linear-backtracking): the two `[^\s@]+` classes either side of the dot
  // overlap, since neither excludes `.`. `extractEmailDomain` (linear indexOf-based, no
  // backtracking) already answers "is this shaped like an email" — reuse it rather than a
  // second, riskier definition. A non-empty local part is the only extra check needed.
  const trimmedDraft = draftEmail.trim();
  const emailValid = trimmedDraft.indexOf('@') > 0 && extractEmailDomain(trimmedDraft) !== null;
  const alreadyAdded = guests.some(
    (g) => g.email.toLowerCase() === draftEmail.trim().toLowerCase()
  );

  function handleAdd(): void {
    const email = draftEmail.trim().toLowerCase();
    if (!emailValid || alreadyAdded || atCap) return;
    onChange([...guests, { email }]);
    setDraftEmail('');
  }

  function handleRemove(email: string): void {
    onChange(guests.filter((g) => g.email !== email));
  }

  const caseLevelGuests = guests.filter((g) => isCaseLevelAccess(g.email, viewerEmailDomain));
  const summary = summaryDisclosure(caseLevelGuests);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-semibold">Invite others</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Optional. They&apos;ll get the join link by email.
        </p>
      </div>

      {guests.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {guests.map((g) => (
            <li
              key={g.email}
              className="border-border bg-muted/50 flex items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2.5 text-xs"
            >
              <UserRound className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              <span className="text-foreground">{g.email}</span>
              <button
                type="button"
                onClick={() => handleRemove(g.email)}
                aria-label={`Remove ${g.email}`}
                className="hover:bg-muted focus-visible:ring-ring rounded-full p-0.5 focus-visible:ring-2 focus-visible:outline-none"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {summary !== null && (
        <p className="text-muted-foreground text-xs leading-relaxed">{summary}</p>
      )}

      <div className="flex gap-2">
        <Input
          type="email"
          value={draftEmail}
          onChange={(e) => setDraftEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="name@company.com"
          disabled={atCap}
          aria-label="Guest email address"
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleAdd}
          disabled={!emailValid || alreadyAdded || atCap}
          aria-label="Add guest"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {disclosure !== null && (
        <p className="text-muted-foreground text-xs leading-relaxed">{disclosure}</p>
      )}

      <p className={cn('text-xs', atCap ? 'text-warning font-medium' : 'text-muted-foreground')}>
        {atCap
          ? "You've reached the 10-person limit for this call."
          : `${total} of ${MAX_TOTAL_PARTICIPANTS} · guests don't change what you pay`}
      </p>
    </div>
  );
}
