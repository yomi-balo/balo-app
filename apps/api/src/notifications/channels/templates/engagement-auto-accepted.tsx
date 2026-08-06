import { ProjectAcceptedEmail } from './engagement-accepted-emails.js';
import type { AutoAcceptedEmailProps } from './engagement-accepted-emails.js';

export type { AutoAcceptedEmailProps };

/**
 * BAL-338 (D7) — `AutoAcceptedEmail` (VARIANT 3 of the project-review email family),
 * sent to the CLIENT company owner when the review window elapses with no decision
 * and the sweep closes the project out as delivered. Implemented VERBATIM (layout AND
 * copy) from `.claude/design-references/email-project-review.jsx` VARIANT 3.
 *
 * BAL-390 — the BODY now lives in `engagement-accepted-emails.tsx`, shared with the
 * explicit-accept client email and discriminated on `method`. The two differ by roughly
 * one sentence, and two near-identical templates would trip SonarCloud's >3% new-code
 * duplication gate. This file stays the home of the VARIANT 3 name and props so its
 * registry entry and `engagement-review-d7.test.ts` are untouched by that move.
 *
 * BAL-390 also fuses the star-rating ask INTO this email rather than adding a second
 * one (D7: one email, never two): pass `reviewToken` and the star row renders after the
 * green window block; omit it and this email is exactly what it was before.
 */
export function AutoAcceptedEmail(props: Readonly<AutoAcceptedEmailProps>) {
  return <ProjectAcceptedEmail method="auto" {...props} />;
}
