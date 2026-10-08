import { Lock } from 'lucide-react';

/**
 * BAL-593 — the one "skills locked" banner, shared by the Expertise and Certifications settings
 * tabs so the two surfaces can't drift on copy or styling. Server-safe: purely presentational, no
 * state, no event handlers, no `'use client'`.
 *
 * Copy is pending-MJ. The support address is `support@getbalo.com`, the dominant address across
 * the codebase.
 */
export function ExpertiseLockedBanner(): React.JSX.Element {
  return (
    <div className="bg-warning/10 border-warning/30 mb-6 flex items-start gap-3 rounded-xl border p-4">
      <Lock className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="text-warning text-[13px] font-semibold">Expertise is locked after approval</p>
        <p className="text-warning/80 mt-1 text-xs">
          Balo verified your skills, products and certifications when you were approved. Languages,
          industries and your other experience stay yours to edit. To ask Balo for a change, email{' '}
          <a href="mailto:support@getbalo.com" className="font-semibold underline">
            support@getbalo.com
          </a>
          {/* An explicit string expression, not bare JSXText,
              so there is no newline-adjacent-to-tag whitespace for a reader (or Prettier's own
              reflow) to add or drop a space from. No space is intended before the period. */}
          {'.'}
        </p>
      </div>
    </div>
  );
}
