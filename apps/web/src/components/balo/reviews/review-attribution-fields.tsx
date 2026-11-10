'use client';

import { useCallback, useId, useState } from 'react';
import { Eye, Lock, X } from 'lucide-react';
import {
  REVIEWER_ROLE_MAX,
  formatReviewAttribution,
  publicReviewNote,
  reviewerRoleProblem,
  type ReviewerRoleProblem,
  type ReviewBodyVisibility,
  type ReviewCaptureIdentity,
  type ReviewSurface,
} from '@balo/shared/reviews';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { REVIEW_EVENTS, track } from '@/lib/analytics';
import { formatUtcMonthYear } from '@/lib/format/local-date';
import { buildAttributionLine } from './attribution-line';
import { ReviewEntry } from './review-entry';

/** `true` when the role, as it will be sent (trimmed), may be saved. Parents gate Save on it. */
export function isReviewerRoleAllowed(role: string): boolean {
  return reviewerRoleProblem(role.trim()) === null;
}

/**
 * What to do about a rejected role. An `@` is almost always an attempt to name the company, so
 * the message points at the checkbox when there is one to tick.
 */
function roleProblemMessage(problem: ReviewerRoleProblem, companyOffered: boolean): string {
  if (problem === 'hidden_character') {
    return 'Your role has a hidden formatting character. Try retyping it.';
  }
  return companyOffered
    ? 'Leave out the @, and tick the box below to show your company.'
    : 'Leave out the @ and write just your role.';
}

/**
 * BAL-628 — the reviewer-attribution controls, shared by `RatingBlock` (four in-app surfaces)
 * and the `/review/{token}` form: the private-note toggle, the role field, the "show my
 * company" checkbox, and the live line that ends in a Preview.
 *
 * ⚠ CONTROLLED, AND IT OWNS ONLY `previewOpen`. The parent holds the three values it will send,
 * so what the live line says and what is written cannot diverge.
 *
 * ⚠ THE CHECKBOX IS NOT RENDERED when the company name may not appear on reviews (a personal
 * workspace, or one an admin hid) or has no name. The parent must still send
 * `identity.companyNameAllowed && showCompany`; the server forces it off regardless.
 *
 * ⚠ THE PREVIEW IS THE REAL `ReviewEntry`, filled from the draft. A private note is never
 * handed to it (`publicReviewNote`), so it cannot appear there. It closes on Escape, an outside
 * click (which includes pressing Save, since Save sits outside the popover) and its own X.
 *
 * ⚠ THE ROLE FIELD REJECTS `@` AND HIDDEN CHARACTERS (`reviewerRoleProblem`) INLINE, because
 * the descriptor is `{Role} @{Company}` and a typed `@` would fake a company. The parent must
 * also disable Save while `!isReviewerRoleAllowed(role)`; the server rejects it regardless.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off.
 */
export function ReviewAttributionFields({
  identity,
  expertName,
  note,
  draftRating,
  bodyVisibility,
  onBodyVisibilityChange,
  role,
  onRoleChange,
  showCompany,
  onShowCompanyChange,
  profileRole,
  surface,
  disabled,
}: Readonly<{
  identity: ReviewCaptureIdentity;
  /** The expert's given name. Never an email address. */
  expertName: string;
  note: string;
  /** The draft star rating, shown in the Preview. */
  draftRating: number;
  bodyVisibility: ReviewBodyVisibility;
  onBodyVisibilityChange: (next: ReviewBodyVisibility) => void;
  role: string;
  onRoleChange: (next: string) => void;
  showCompany: boolean;
  onShowCompanyChange: (next: boolean) => void;
  /**
   * The saved job title the role field was seeded with, or `null` when it was not seeded from
   * one (an existing review's own role is not a profile seed). Drives the "From your last
   * review" helper, which shows only while the field still holds this value.
   */
  profileRole: string | null;
  surface: ReviewSurface;
  disabled: boolean;
}>): React.JSX.Element {
  const roleId = useId();
  const roleHelpId = useId();
  const roleErrorId = useId();
  const companyId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);

  const trimmedNote = note.trim();
  const hasNote = trimmedNote.length > 0;
  const companyOffered = identity.companyNameAllowed && identity.companyName !== null;
  const effectiveShowCompany = companyOffered && showCompany;
  const roleProblem = reviewerRoleProblem(role.trim());
  const roleInvalid = roleProblem !== null;
  const showProfileHelper = profileRole !== null && role !== '' && role === profileRole;

  const attribution = formatReviewAttribution({
    firstName: identity.reviewerFirstName,
    lastInitial: identity.reviewerLastInitial,
    role,
    companyName: identity.companyName,
    industryName: identity.industryName,
    showCompany,
    companyNameAllowed: identity.companyNameAllowed,
  });
  const line = buildAttributionLine({ expertName, attribution, hasNote, bodyVisibility });
  const LineIcon = line.privateNote ? Lock : Eye;

  const toggleVisibility = useCallback(() => {
    onBodyVisibilityChange(bodyVisibility === 'private' ? 'public' : 'private');
  }, [bodyVisibility, onBodyVisibilityChange]);

  const handleRole = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onRoleChange(event.target.value),
    [onRoleChange]
  );

  const handleCompany = useCallback(
    (checked: boolean | 'indeterminate') => onShowCompanyChange(checked === true),
    [onShowCompanyChange]
  );

  const handlePreviewOpenChange = useCallback(
    (open: boolean) => {
      setPreviewOpen(open);
      if (open) {
        track(REVIEW_EVENTS.PREVIEW_OPENED, {
          surface,
          has_body: hasNote,
          show_company: effectiveShowCompany,
          body_visibility: bodyVisibility,
        });
      }
    },
    [bodyVisibility, effectiveShowCompany, hasNote, surface]
  );

  return (
    <div className="mt-3 w-full text-left">
      {hasNote && (
        <Button
          type="button"
          variant="link"
          disabled={disabled}
          onClick={toggleVisibility}
          className="h-auto min-h-11 p-0 text-[13.5px] font-medium"
        >
          {bodyVisibility === 'private'
            ? `Show the note on ${expertName}’s profile instead`
            : 'Send the note to Balo privately instead'}
        </Button>
      )}

      <div className="mt-3">
        <Label htmlFor={roleId} className="text-foreground text-sm font-semibold">
          Your role <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id={roleId}
          type="text"
          value={role}
          onChange={handleRole}
          maxLength={REVIEWER_ROLE_MAX}
          disabled={disabled}
          placeholder="e.g. Head of Sales Operations"
          aria-invalid={roleInvalid}
          aria-describedby={roleInvalid ? `${roleHelpId} ${roleErrorId}` : roleHelpId}
          className="mt-2 max-w-sm"
        />
        <p id={roleHelpId} className="text-muted-foreground mt-1.5 text-xs">
          {showProfileHelper
            ? 'From your last review. Update it if it’s changed.'
            : 'We’ll remember it for your next review.'}
        </p>
        {roleProblem !== null && (
          <p id={roleErrorId} className="text-destructive mt-1 text-xs">
            {roleProblemMessage(roleProblem, companyOffered)}
          </p>
        )}
      </div>

      {companyOffered && (
        <div className="mt-4 flex min-h-11 items-center gap-2.5">
          <Checkbox
            id={companyId}
            checked={showCompany}
            onCheckedChange={handleCompany}
            disabled={disabled}
          />
          <Label htmlFor={companyId} className="text-foreground text-sm font-normal">
            Show {identity.companyName} on the review
          </Label>
        </div>
      )}

      <div className="border-border/60 mt-4 border-t pt-3.5">
        <Popover open={previewOpen} onOpenChange={handlePreviewOpenChange}>
          <div className="text-muted-foreground flex items-start gap-2 text-[13px] leading-normal">
            <LineIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p aria-live="polite" className="min-w-0">
              {line.text}
            </p>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="link"
                aria-haspopup="dialog"
                className="inline-flex h-auto min-h-11 shrink-0 items-center p-0 text-[13px] font-semibold"
              >
                Preview
              </Button>
            </PopoverTrigger>
          </div>
          <PopoverContent
            align="start"
            aria-label={`How it appears on ${expertName}’s profile`}
            className="w-[min(32rem,calc(100vw-2rem))] p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-[13px] font-semibold">
                How it appears on {expertName}’s profile
              </span>
              <PopoverClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close preview"
                  className="text-muted-foreground size-8"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </PopoverClose>
            </div>
            <ReviewEntry
              engagementKind={identity.engagementKind}
              rating={draftRating}
              dateLabel={formatUtcMonthYear(new Date())}
              topics={[]}
              sharedCompanyName={null}
              first
              raters={[
                {
                  id: 'draft',
                  attribution,
                  rating: draftRating,
                  note: publicReviewNote({
                    body: hasNote ? trimmedNote : null,
                    bodyVisibility,
                  }),
                },
              ]}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
