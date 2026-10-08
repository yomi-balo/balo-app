/**
 * experts/expert-profile-limits — the ONE definition of the language and industry caps an
 * expert profile may carry. The expert's settings save and the staff edit both validate against
 * these, so neither can store a set the other later refuses.
 *
 * PURE. No I/O, no clock, no `@balo/db`.
 */

/** Maximum number of languages an expert profile may list. */
export const EXPERT_LANGUAGES_MAX = 10;

/** Maximum number of industries an expert profile may list. */
export const EXPERT_INDUSTRIES_MAX = 20;
