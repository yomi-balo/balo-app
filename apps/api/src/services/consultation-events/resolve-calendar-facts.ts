import {
  caseEngagementsRepository,
  companiesRepository,
  engagementsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import { resolveContextOwner, type MeetingContextOwnerReads } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import {
  CALENDAR_CONTEXT_REGISTRY,
  type CalendarProjectedContextType,
  type CalendarSubjectSource,
} from './calendar-context-registry.js';

/**
 * BAL-433 Slice 1 — THE DISPLAY FACTS one booking contributes to the expert's calendar entry:
 * everything that differs BETWEEN contexts, and nothing that does not.
 *
 * ⚠ THIS RESOLVES DISPLAY FACTS AND JUDGES NOTHING. It re-runs no gate — not
 * `authorizeMeetingBooking`, not `relationshipDeniesHosting`, not a post-decision status
 * check. All of them ran BEFORE the booking committed, and re-deciding here could only
 * withhold a calendar entry from a meeting that legitimately exists.
 *
 * ⚠ NEVER THROWS. The booking has already committed by the time anything here runs
 * (`provision-meeting.ts`'s post-commit projection), so every failure degrades to `undefined`
 * plus a log line. A best-effort projection must never be able to reject the promise a
 * committed booking returns on.
 */

/** The facts, resolved. */
export interface ExpertCalendarFacts {
  /** ADR-1044 §4 — the expert's event headline names the client COMPANY, never a person. */
  readonly clientCompanyName: string;
  /** The subject line rendered above the join URL. Never blank — see {@link titleOr}. */
  readonly title: string;
  /** The headline noun, straight off the registry. */
  readonly eventLabel: string;
}

/**
 * A title that is absent or blank reads as a bug on a calendar — fall back to the label.
 * Moved VERBATIM from `provision-meeting.ts`, which is why `request_interaction`'s shipped
 * blank-title behaviour is byte-identical after BAL-433.
 */
export function titleOr(title: string | null | undefined, fallback: string): string {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * The subject line above the join URL, for one `subjectSource`.
 *
 * ⚠ NO `default:` ARM, DELIBERATELY. A fourth {@link CalendarSubjectSource} fails
 * `pnpm --filter api typecheck` RIGHT HERE until a resolution is consciously written for it.
 */
async function resolveSubject(
  source: CalendarSubjectSource,
  contextId: string,
  capturedRequest: { title: string | null } | undefined
): Promise<string | null> {
  switch (source) {
    case 'case_title': {
      // ⚠ A SECOND READ, AND IT IS NOT THE SAME ROW. `resolveContextOwner` resolved the
      // SUPERTYPE (`engagements.company_id`); the title lives on the `case_engagements`
      // SUBTYPE and no injected read of that rule touches it. Same shape as
      // `resolveMeetingContextLabel`, which reads the subtype for exactly this reason.
      //
      // ⚠⚠ DELIBERATE DIVERGENCE FROM THE PRE-BAL-433 BEHAVIOUR — DO NOT "FIX" IT BACK. The
      // old per-context resolver read the SUBTYPE to get the company, so a missing or
      // soft-deleted `case_engagements` row SKIPPED the projection entirely. Existence is now
      // decided on the SUPERTYPE by `resolveContextOwner`, so a missing subtype row only
      // degrades the subject to the registry label ('Consultation') and the calendar entry is
      // STILL WRITTEN. That is the better answer: the meeting exists and genuinely blocks the
      // expert's calendar, so withholding the entry over a missing title would leave a real
      // booking invisible. `not_found` on the SUPERTYPE still skips, as it always did.
      const row = await caseEngagementsRepository.findByEngagementId(contextId);
      return row?.title ?? null;
    }
    case 'request_title':
      return capturedRequest?.title ?? null;
    case 'label':
      // ⚠ NOT AN OMISSION. `titleOr` turns this into the registry's own label, so the event
      // body keeps its shape (`subject\n\njoinUrl`) for every context — a calendar entry
      // whose only body is a bare link reads as unfinished.
      return null;
  }
}

/**
 * Resolve the display facts for ONE bookable context.
 *
 * `undefined` means "nothing to project" — the context, its company, or a hop between them
 * has no live row. Missing and soft-deleted collapse to the same answer, because every
 * injected read filters `deleted_at IS NULL` and this module cannot tell them apart (nor does
 * it need to).
 */
export async function resolveExpertCalendarFacts(
  contextType: CalendarProjectedContextType,
  contextId: string,
  log: FastifyBaseLogger
): Promise<ExpertCalendarFacts | undefined> {
  const descriptor = CALENDAR_CONTEXT_REGISTRY[contextType];

  try {
    /**
     * ⚠ THE REQUEST ROW IS CAPTURED FROM THE INJECTED READ, NEVER FETCHED AGAIN. A second
     * `findById` could observe a row that changed between the two reads, so the title and the
     * company id would describe different states. This is `loadSubject`'s stated rule and the
     * reason the pre-BAL-433 resolver already did it.
     */
    let capturedRequest: { title: string | null } | undefined;
    const reads: MeetingContextOwnerReads = {
      findEngagement: (id) => engagementsRepository.findById(id),
      findProjectRequest: async (id) => {
        const row = await projectRequestsRepository.findById(id);
        capturedRequest = row;
        return row;
      },
      findRelationship: (id) => requestExpertRelationshipsRepository.findById(id),
    };

    /**
     * ⚠⚠ THE OWNER HOP IS NOT RE-DERIVED HERE. `resolveContextOwner` (`@balo/shared/meetings`)
     * is the ONE sanctioned rule for "which party owns this context" — the same one
     * `authorize-meeting-booking.ts`'s `loadSubject` uses. A second copy is how the EXPERT and
     * the COMPANY get read off the wrong rows (the axis confusion ADR-1029 forbids).
     */
    const owner = await resolveContextOwner({ contextType, contextId }, reads);
    if (owner.outcome !== 'resolved') {
      log.info(
        { contextType, contextId },
        'No live context for this booking — skipping the calendar projection'
      );
      return undefined;
    }

    const company = await companiesRepository.findById(owner.owner.companyId);
    if (company === undefined) {
      log.info(
        { contextType, contextId },
        'No live company for this context — skipping the calendar projection'
      );
      return undefined;
    }

    const subject = await resolveSubject(descriptor.subjectSource, contextId, capturedRequest);

    return {
      clientCompanyName: company.name,
      title: titleOr(subject, descriptor.eventLabel),
      eventLabel: descriptor.eventLabel,
    };
  } catch (error) {
    // ⚠ CAUGHT ERROR BOUNDARY (CLAUDE.md). The booking has already committed; a repository
    // wobble here must degrade to a logged no-op, never to a rejected promise.
    // ⚠ NO TITLE AND NO COMPANY NAME IN THE LOG — the ids identify the rows.
    log.error(
      {
        contextType,
        contextId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to resolve display facts for the expert calendar projection'
    );
    return undefined;
  }
}
