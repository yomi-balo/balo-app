'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { ExpertAvatarMedia, MatchMedia } from './recipient-media';

export type ProjectRouting = 'direct' | 'match';

/** Expert display data used by the recipient card, review summary and done copy. */
export interface ProjectRequestExpert {
  name: string;
  firstName: string;
  initials: string;
  /** R2 key / http URL for the avatar. */
  avatarKey: string | null;
  headline: string | null;
  /** False when the expert isn't taking on new work — Direct is blocked for them. */
  availableForWork: boolean;
}

interface ExpertUnavailableNoticeProps {
  firstName: string;
  onMatchInstead: () => void;
}

/** Inline notice for an expert who isn't taking on new work, with a way to get matched instead. */
export function ExpertUnavailableNotice({
  firstName,
  onMatchInstead,
}: Readonly<ExpertUnavailableNoticeProps>): React.JSX.Element {
  return (
    <div className="border-warning/40 bg-warning/15 text-warning-strong mt-3 flex gap-2.5 rounded-lg border p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-xs">
        <p className="font-semibold">{firstName} isn&apos;t taking on new work right now.</p>
        <p className="mt-0.5">
          Your brief is saved. We can match you with someone with similar experience instead.
        </p>
        <button
          type="button"
          onClick={onMatchInstead}
          className="bg-warning text-warning-foreground focus-visible:ring-ring mt-2.5 inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Get matched instead
        </button>
      </div>
    </div>
  );
}

interface SendToSelectorProps {
  value: ProjectRouting;
  onChange: (next: ProjectRouting) => void;
  /** Absent → context-free mount: always "Find me an expert", with nothing to choose. */
  expert?: ProjectRequestExpert;
  /** The line under the recipient block (`RoutingCopy.formDescription`); omitted while Direct is blocked. */
  helperText: string;
}

/**
 * Where the request goes — decided by the entry point, not picked from a list. A context-free
 * mount is a static "Find me an expert" block. An expert-bound mount pins the expert's card
 * (Direct) with a text toggle to get matched instead and back; an expert who isn't taking on
 * new work shows the unavailable notice in place of the toggle until the client switches.
 */
export function SendToSelector({
  value,
  onChange,
  expert,
  helperText,
}: Readonly<SendToSelectorProps>): React.JSX.Element {
  const direct = expert !== undefined && value === 'direct';
  const blocked = direct && !expert.availableForWork;
  const showToggle = expert !== undefined && !blocked;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggleRef = useRef(false);

  // After "Get matched instead" the notice (and its button) unmounts; hand focus to the toggle
  // that takes its place so keyboard and screen-reader users aren't dropped back to the page.
  useEffect(() => {
    if (!focusToggleRef.current || value !== 'match') return;
    focusToggleRef.current = false;
    toggleRef.current?.focus();
  }, [value]);

  const handleMatchInstead = useCallback(() => {
    focusToggleRef.current = true;
    onChange('match');
  }, [onChange]);

  return (
    <div>
      <div aria-live="polite" className="border-primary bg-primary/[0.06] rounded-xl border p-4">
        {direct ? (
          <>
            <div className="flex items-start gap-3">
              <ExpertAvatarMedia avatarKey={expert.avatarKey} initials={expert.initials} />
              <div className="min-w-0 flex-1">
                <p className="text-foreground text-sm font-semibold">{expert.name}</p>
                {expert.headline !== null && (
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                    {expert.headline}
                  </p>
                )}
              </div>
            </div>
            {!expert.availableForWork && (
              <ExpertUnavailableNotice
                firstName={expert.firstName}
                onMatchInstead={handleMatchInstead}
              />
            )}
          </>
        ) : (
          <div className="flex items-center gap-3">
            <MatchMedia />
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-semibold">Find me an expert</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                We&apos;ll match you with the right fit.
              </p>
            </div>
          </div>
        )}
      </div>
      {!blocked && <p className="text-muted-foreground mt-2 text-xs">{helperText}</p>}
      {showToggle && (
        <button
          ref={toggleRef}
          type="button"
          onClick={() => onChange(direct ? 'match' : 'direct')}
          className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {direct ? 'Get matched with someone else instead' : `Send to ${expert.firstName} instead`}
        </button>
      )}
    </div>
  );
}
