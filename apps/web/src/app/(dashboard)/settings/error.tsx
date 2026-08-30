'use client';

import { SectionError } from '@/components/balo/section/section-states';

/**
 * BAL-503 — the ONE route error boundary for the client Settings tree, rendered INSIDE
 * `settings/layout.tsx` so the tab bar survives a section failure. Nearest-boundary resolution
 * means `settings/team/error.tsx` still wins for the team segment — this boundary covers
 * `company`, `billing`, and `notifications`.
 */
export default function SettingsError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl py-8">
      <SectionError label="this settings section" onRetry={reset} />
    </div>
  );
}
