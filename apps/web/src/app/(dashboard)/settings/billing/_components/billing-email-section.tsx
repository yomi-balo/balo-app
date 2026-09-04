'use client';

import { useCallback, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveBillingEmailAction } from '@/lib/credit/actions';
import type { BillingEmailSnapshot } from '@/lib/credit/wallet-read';

interface BillingEmailSectionProps {
  readonly initial: BillingEmailSnapshot;
}

const SAVE_FAILURE_MESSAGE = "We couldn't save that — please try again.";
const SAVE_SUCCESS_MESSAGE = 'Billing email updated.';
const UNAUTHORIZED_MESSAGE =
  'You no longer have permission to change billing settings — ask a company owner or admin to make this change.';
const INVALID_EMAIL_MESSAGE = 'Enter a valid email address.';

/**
 * A linear, ReDoS-free plausibility check for an email address — mirrors the server's Zod
 * `.email()` intent without shipping a heavy validator, following the `share-modal.tsx`
 * idiom: no backtracking regex, exactly one `@` with text before it, and a dotted,
 * non-terminal domain after.
 */
function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return false;
  if (/\s/.test(email)) return false; // constant regex — no super-linear surface
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function formatSetAt(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * `provenanceLine`'s four-way copy table, split out so the name-known and name-unknown arms are
 * flat early returns rather than nested ternaries. Callers pass the already-formatted `date`.
 */
function provenanceBase(snapshot: BillingEmailSnapshot, date: string): string {
  const isSet = snapshot.source === 'set';
  if (snapshot.setByName === null) {
    return isSet ? `Set on ${date}` : `Seeded at the first top-up on ${date}`;
  }
  return isSet
    ? `Set by ${snapshot.setByName} on ${date}`
    : `Seeded from ${snapshot.setByName}'s first top-up on ${date}`;
}

/**
 * Decision 2's provenance line (plan §7.3's copy table). Pure — no reads. `email === null` is
 * the pre-seed empty state: an invitation, never absence-framed ("No billing email yet").
 * Attribution names the PERSON (retrospective — CLAUDE.md), with no "@ company" clause: the
 * client is already inside their own workspace's settings, so the company is the frame.
 *
 * ⚠ Copy is pending MJ sign-off (plan §7.3) — the shape is fixed, the words are not.
 */
function provenanceLine(snapshot: BillingEmailSnapshot): string {
  if (snapshot.email === null || snapshot.setAt === null) {
    return 'Set automatically at your first top-up — or add one now.';
  }
  const base = provenanceBase(snapshot, formatSetAt(snapshot.setAt));
  return snapshot.setByIsFormerMember ? `${base} (no longer a member)` : base;
}

/**
 * BAL-522 — "Billing email", the last section on `/settings/billing`. Shell and idiom copied
 * from `low-balance-section.tsx`: card shell → control → dirty-gated Save. Local `draft` seeds
 * from `initial.email ?? ''`; `snapshot` tracks the full committed projection (re-seeded on a
 * successful Save from the ACTION'S RESPONSE — never guessed locally, the doctrine
 * `billing-settings-sections.tsx` already documents).
 *
 * NOT BLANKABLE (decision 3) — Save is disabled whenever the draft is empty; there is no
 * "clear" affordance. On failure the draft is NEVER reverted (the `low-balance-section` rule) —
 * the client can retry without re-typing.
 */
export function BillingEmailSection({
  initial,
}: Readonly<BillingEmailSectionProps>): React.JSX.Element {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<BillingEmailSnapshot>(initial);
  const [draft, setDraft] = useState<string>(initial.email ?? '');
  const [pending, setPending] = useState(false);

  const trimmed = draft.trim();
  const isDirty = trimmed !== (snapshot.email ?? '');
  const showInvalid = trimmed.length > 0 && !isPlausibleEmail(trimmed);
  const canSave = isDirty && trimmed.length > 0 && isPlausibleEmail(trimmed) && !pending;

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value);
  }, []);

  const runSave = useCallback(async (): Promise<void> => {
    setPending(true);
    try {
      const result = await saveBillingEmailAction({ billingEmail: trimmed });
      if (!result.ok) {
        toast.error(result.error === 'unauthorized' ? UNAUTHORIZED_MESSAGE : SAVE_FAILURE_MESSAGE);
        return;
      }
      // The response is server truth — repaint from it, never from the just-typed draft. And
      // ONLY on `updated`: an `unchanged` reply wrote nothing, so the stored provenance still
      // belongs to whoever last actually changed it (possibly a seed, possibly someone else, on
      // a date this actor had nothing to do with). Repainting it here would put a false claim on
      // a screen whose whole job is provenance; `router.refresh()` below re-reads server truth.
      if (result.status === 'updated') {
        setSnapshot({
          email: result.billingEmail,
          source: result.source,
          setAt: result.setAt,
          setByName: result.setByName,
          // The actor who just saved this IS, by definition, a current holder (they passed the
          // capability gate moments ago) — not a guess, a fact about this very call.
          setByIsFormerMember: false,
        });
      }
      setDraft(result.billingEmail);
      toast.success(SAVE_SUCCESS_MESSAGE);
      router.refresh();
    } catch {
      toast.error(SAVE_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  }, [trimmed, router]);

  const handleSaveClick = useCallback((): void => {
    runSave().catch(() => undefined);
  }, [runSave]);

  return (
    <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">
      <h3 className="text-foreground text-sm font-semibold">Billing email</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Where Stripe keeps your team&apos;s billing record — used for disputes and support lookup.
        Balo sends your receipts itself.
      </p>

      <div className="mt-4">
        <Label htmlFor="billing-email">Billing email</Label>
        <Input
          id="billing-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={draft}
          onChange={handleChange}
          placeholder="name@company.com"
          aria-invalid={showInvalid}
          // The error node is named FIRST so a screen reader hears WHY the field is invalid
          // before the provenance line — `aria-invalid` alone announces "invalid" and nothing
          // else. Mirrors `LowBalanceModePicker`'s `errorId` association.
          aria-describedby={
            showInvalid ? 'billing-email-error billing-email-help' : 'billing-email-help'
          }
          className="mt-1.5"
        />
        {showInvalid && (
          <p id="billing-email-error" className="text-destructive mt-1.5 text-xs" role="alert">
            {INVALID_EMAIL_MESSAGE}
          </p>
        )}
        <p id="billing-email-help" className="text-muted-foreground mt-1.5 text-xs">
          {provenanceLine(snapshot)}
        </p>
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          onClick={handleSaveClick}
          disabled={!canSave}
          // The VISIBLE label stays "Save changes" (it sits under its own section heading, where
          // that reads naturally). `low-balance-section.tsx` renders an identical one on this
          // same route, so out of context — a screen reader's button list — the two were
          // indistinguishable. The accessible name disambiguates; the visible one does not change.
          aria-label="Save billing email"
          className="active:scale-[0.98] motion-reduce:active:scale-100"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save changes'
          )}
        </Button>
      </div>
    </div>
  );
}
