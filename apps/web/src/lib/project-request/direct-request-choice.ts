/**
 * Copy for the take-it-on-or-pass choice on a DIRECT request (BAL-604).
 *
 * The predicate (`directExpertOwesChoice`) lives in `@balo/shared/project-requests`; the
 * request-page nudge and the projects-inbox row both read it, and use this copy once it holds.
 */

/** The inbox / Your move label for the choice. */
export const DIRECT_CHOICE_LABEL = 'Take it on, or pass?'; // pending-MJ

/** The request-page nudge headline for the choice — names the client party. */
export function directChoiceHeadline(companyName: string): string {
  return `${companyName} asked for you directly. Take it on, or pass?`; // pending-MJ
}
