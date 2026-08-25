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

/**
 * BAL-283 (round-1 C4) — WHAT A SAME-DOMAIN GUEST ACTUALLY GAINS, on THIS surface.
 *
 * ⚠ `'case'` COPY IS FACTUALLY FALSE PRE-ENGAGEMENT AND MUST NOT BE THE ONLY OPTION. An intro
 * call on a project-request thread happens BEFORE any engagement exists: there is no case, and
 * no prior consultation to be given access to. Promising "this whole case, including
 * consultations held before today" on that surface fires on the COMMON path (a client inviting
 * a same-domain colleague) and promises access that does not exist.
 */
export type GuestAccessScope = 'case' | 'call';

export interface GuestInviteComposerProps {
  guests: readonly GuestDraft[];
  onChange: (guests: readonly GuestDraft[]) => void;
  /** `booker + expert` — the composer adds `guests.length` to compute the 10-cap. */
  otherParticipantCount: number;
  /** The actor's own email domain, for the live "same company as you" disclosure. `null` if unknown. */
  viewerEmailDomain: string | null;
  /** For the "Outside {client company}" copy. `null` falls back to "your company". */
  clientCompanyName: string | null;
  /**
   * What a same-company guest is being given. Defaults to `'case'` — BAL-400's original and
   * only behaviour, so every existing call site is unchanged byte-for-byte.
   */
  accessScope?: GuestAccessScope;
  /**
   * BAL-283 (round-1 C3) — whether the participant counter carries the "guests don't change
   * what you pay" clause. Defaults to `true` (BAL-400's behaviour). Pass `false` on a surface
   * where NOTHING is paid: money framing there is both a Ruling-2 violation and a
   * non-sequitur — there is nothing to pay, so reassuring the user about it invents a concern.
   */
  showPricingNote?: boolean;
}

const MAX_TOTAL_PARTICIPANTS = 10;

/**
 * True when adding this address grants access BEYOND this one call — i.e. same verified
 * company domain. On an `accessScope: 'call'` surface the WIDER grant does not exist, but the
 * "same company as you" fact is still what decides which disclosure line to show.
 */
function isCaseLevelAccess(email: string, viewerEmailDomain: string | null): boolean {
  const domain = extractEmailDomain(email);
  if (domain === null) return false;
  return viewerEmailDomain !== null && domain === viewerEmailDomain && !isBlockedDomain(domain);
}

/** Live, per-keystroke disclosure of what THIS address (if added) would grant — an ESTIMATE. */
function liveDisclosure(
  email: string,
  viewerEmailDomain: string | null,
  companyName: string | null,
  accessScope: GuestAccessScope
): string | null {
  const domain = extractEmailDomain(email);
  if (domain === null) return null;
  if (isCaseLevelAccess(email, viewerEmailDomain)) {
    return accessScope === 'case'
      ? 'Same company as you — they’ll see this whole case, including consultations held before today.'
      : 'Same company as you — they’ll only see this intro call and its recap.';
  }
  const company = companyName ?? 'your company';
  return `Outside ${company}, or a personal email address — they'll only see this call and its recap.`;
}

/**
 * UX-4 (BAL-400 round 2) — the PERSISTENT, post-add record of what access was actually
 * granted, distinct from `liveDisclosure`'s per-keystroke estimate (which disappears the
 * instant the draft is cleared). Design §Copy Reference — singular/plural summary disclosure.
 * `null` when no added guest resolved to same-company access.
 */
function summaryDisclosure(
  caseLevelGuests: readonly GuestDraft[],
  accessScope: GuestAccessScope
): string | null {
  const [only, ...rest] = caseLevelGuests;
  if (only === undefined) return null;
  if (accessScope === 'call') {
    // Nothing exists beyond this call yet, so there is no wider grant to disclose — only the
    // plain fact of who is coming.
    return rest.length === 0
      ? `${only.name ?? only.email} will only see this intro call and its recap.`
      : `${caseLevelGuests.length} people will only see this intro call and its recap.`;
  }
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
  accessScope = 'case',
  showPricingNote = true,
}: Readonly<GuestInviteComposerProps>): React.JSX.Element {
  const [draftEmail, setDraftEmail] = useState('');
  const total = otherParticipantCount + guests.length;
  const atCap = total >= MAX_TOTAL_PARTICIPANTS;

  const disclosure =
    draftEmail.trim().length > 0
      ? liveDisclosure(draftEmail, viewerEmailDomain, clientCompanyName, accessScope)
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
  const summary = summaryDisclosure(caseLevelGuests, accessScope);
  // ⚠ Positive condition first (SonarCloud S7735 — no negated condition with an else).
  const countLabel = showPricingNote
    ? `${total} of ${MAX_TOTAL_PARTICIPANTS} · guests don't change what you pay`
    : `${total} of ${MAX_TOTAL_PARTICIPANTS}`;

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
        {atCap ? "You've reached the 10-person limit for this call." : countLabel}
      </p>
    </div>
  );
}
