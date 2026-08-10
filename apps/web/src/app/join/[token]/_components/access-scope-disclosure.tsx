import { ShieldQuestion, Video } from 'lucide-react';
import type { GuestAccessScopeLabel } from '@balo/shared/meetings';

interface AccessScopeDisclosureProps {
  /**
   * The grant AS RECORDED on the guest's row at invite time — never re-derived here.
   * `meeting_guests.access_scope` is stored precisely so a later `party_domains` change
   * cannot silently rewrite what the inviter agreed to.
   */
  readonly accessScope: GuestAccessScopeLabel;
}

/**
 * ⚠⚠ THE INFORMED-CONSENT SURFACE, RECIPIENT SIDE (BAL-408 / ADR-1044, design reference
 * `.claude/design-references/guest-invitation.jsx:289`).
 *
 * An `engagement`-scoped grant is **RETROSPECTIVE** (decided 2026-07-30): a same-domain
 * guest invited to consultation 4 can read the recaps, transcripts and action items of
 * 1–3 — including calls held before they existed as a guest. `guestMayReadMeeting` in
 * `@balo/shared/meetings` contains NO date comparison anywhere, and that absence IS the
 * decision. Forward-only scoping was considered and rejected (colleagues collaborating on
 * one issue should see the whole issue), so the entire mitigation is DISCLOSURE — stated
 * to the inviter in the composer, and stated HERE to the person it is about.
 *
 * ⚠ THIS IS THE MIRROR OF THE PROTOTYPE'S SENTENCE, NOT A REWRITE OF IT. The composer
 * says, of a third party: "{name} will be able to read every call in this piece of work —
 * recaps, transcripts and action items — including ones held before they were invited."
 * The only change permitted here is GRAMMATICAL PERSON (third → second). The clause list
 * ("recaps, transcripts and action items") and the retrospective clause ("including ones
 * held before…") are load-bearing and must survive any copy pass: they are the two things
 * a reader would be surprised by later.
 *
 * ⚠⚠ "THIS PIECE OF WORK", NEVER "THIS CASE" — AND THAT IS A CORRECTION, NOT A PREFERENCE.
 * `resolveGuestAccessScope` awards `engagement` scope on ANY engagement-grain context:
 * `case`, `project_kickoff`, `package_session` and `retainer_checkin` alike. `case` is one
 * of four `engagement_type` values (ADR-1045), so "every consultation in this case" was
 * simply false for three of them — and it contradicted the INVITE EMAIL, which describes
 * the identical grant engagement-type-agnostically. Two disclosures of one grant must not
 * disagree; the agnostic wording is the one that is true in every case, so both use it.
 * (Threading the engagement type down here was the alternative and was rejected: it would
 * put a `meeting_contexts` → `engagements` read on a purely presentational component for
 * a distinction the reader does not need.)
 *
 * ⚠ FUTURE TENSE IS ACCURATE, NOT ASPIRATIONAL. BAL-408 **RECORDS** the grant; the read
 * surfaces it describes are BAL-388's (recap), BAL-387's (transcripts, inert) and
 * BAL-391's (action items, inert). Nothing on the platform enforces or serves this grant
 * to a guest today — there is no guest-authenticated read session at all. "You'll be able
 * to read" is therefore the correct tense for what has been GRANTED. **BAL-388 must call
 * `guestMayReadMeeting` to enforce it rather than re-derive the rule.**
 *
 * ⚠ IT NAMES NO ORGANISATION AND NO PERSON. The inviter's company is stated once, above,
 * in the attribution line; repeating it here would make the disclosure vary by viewer for
 * no informational gain — and this block is also rendered on the `meeting` branch, where
 * the whole point is that no organisation-wide grant exists.
 *
 * PURE PRESENTATION, NO `'use client'`, NO `@balo/db`: it takes one enum label and renders.
 * Keeping it out of the client graph is what keeps `postgres`/`node:tls` out of the bundle
 * (memory `reference_balo_db_client_bundle_footgun`) — the RSC does every read.
 *
 * DRAFT COPY — pending MJ sign-off. This is the MJ copy checkpoint the design reference
 * flags by name.
 */
export function AccessScopeDisclosure({
  accessScope,
}: Readonly<AccessScopeDisclosureProps>): React.JSX.Element {
  if (accessScope === 'engagement') {
    return (
      <div className="border-warning/30 bg-warning/10 mt-6 flex items-start gap-2.5 rounded-xl border px-3.5 py-3">
        <ShieldQuestion className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-foreground text-[13px] font-semibold">
            What you&apos;ll be able to see
          </h2>
          <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
            You&apos;ll be able to read every call in this piece of work — recaps, transcripts and
            action items — including ones held before you were invited.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/40 mt-6 flex items-start gap-2.5 rounded-xl border px-3.5 py-3">
      <Video className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {/* ⚠ AN `<h2>`, NOT A BOLD `<p>`. This is the one block on the page whose entire job
            is informed consent; as a styled paragraph it was invisible to heading navigation,
            so a screen-reader user had no landmark for the disclosure they are being asked to
            act on. `<h1>` is the card's headline, so `<h2>` is the correct level. */}
        <h2 className="text-foreground text-[13px] font-semibold">
          What you&apos;ll be able to see
        </h2>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
          You&apos;ll only see this call and its recap — nothing else from the work around it.
        </p>
      </div>
    </div>
  );
}
