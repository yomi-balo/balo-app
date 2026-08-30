import { STEP_CONFIG, type StepKey } from '@/app/(apply)/expert/apply/_actions/schemas';
import type { AnonymousApplicationDraftV1 } from './anonymous-draft';
import type { DraftFlushOutcome } from '@balo/analytics/events';

/**
 * BAL-502 §22.9 — replays an anonymous sessionStorage draft into the EXISTING
 * `/api/expert/apply/flush-draft` route (which owns auth, Zod validation, and the
 * idempotent transactional writes). No new write path.
 *
 * ⚠ This is a plain awaited `fetch`, NOT `navigator.sendBeacon` — a beacon's `true`
 * means the UA queued the bytes, never that the server stored them (BAL-342), and
 * this module must read a response to obtain the minted `expertProfileId`, which a
 * beacon cannot do. Keep it structurally separate from the unload-beacon flush in
 * `expert-application-context.tsx` — this path must never advance
 * `lastSavedByStepRef` / `beaconAttemptByStepRef`.
 */

// FIX round (smaller item) — `DraftFlushOutcome` is the ONE definition (was
// duplicated verbatim here and in `packages/analytics/src/events/expert.ts:22`,
// which is what `track(EXPERT_EVENTS.APPLICATION_DRAFT_FLUSHED, { outcome })`
// actually types its payload against). Imported above instead of re-declared;
// re-exported so any existing consumer of this module's `FlushOutcome` name can
// still get it from here.
export type { DraftFlushOutcome };

export interface FlushResult {
  outcome: DraftFlushOutcome;
  stepsFlushed: number;
  expertProfileId: string | null;
}

interface FlushPostResponse {
  success: boolean;
  expertProfileId: string;
}

async function defaultPost(body: unknown): Promise<FlushPostResponse> {
  const response = await fetch('/api/expert/apply/flush-draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as FlushPostResponse;
}

type DbWritingStep = Exclude<StepKey, 'profile' | 'agency' | 'terms'>;

// `products`, `assessment`, `certifications`, `work-history` — in STEP_CONFIG order,
// `profile` posted separately first (it mints `expertProfileId`), `agency`/`terms`
// skipped entirely (`saveDraftAction` writes nothing for either — save-draft.ts:98-99).
const REMAINING_STEP_ORDER: readonly DbWritingStep[] = STEP_CONFIG.map((step) => step.key).filter(
  (key): key is DbWritingStep => key !== 'profile' && key !== 'agency' && key !== 'terms'
);

export async function flushAnonymousDraft(args: {
  draft: AnonymousApplicationDraftV1;
  hasServerDraft: boolean;
  post?: (body: unknown) => Promise<FlushPostResponse>;
}): Promise<FlushResult> {
  const { draft, hasServerDraft } = args;
  const post = args.post ?? defaultPost;

  // Server wins (§22.11) — an existing server-side draft for the account being
  // signed into always supersedes the anonymous envelope. Nothing is posted.
  if (hasServerDraft) {
    return { outcome: 'superseded', stepsFlushed: 0, expertProfileId: null };
  }

  const profileData = draft.steps.profile;
  if (profileData === undefined) {
    return { outcome: 'nothing_to_flush', stepsFlushed: 0, expertProfileId: null };
  }

  let stepsFlushed = 0;
  let expertProfileId: string;

  try {
    const profileResult = await post({ step: 'profile', data: profileData });
    if (!profileResult.success) {
      return { outcome: 'failed', stepsFlushed, expertProfileId: null };
    }
    expertProfileId = profileResult.expertProfileId;
    stepsFlushed += 1;
  } catch {
    return { outcome: 'failed', stepsFlushed, expertProfileId: null };
  }

  for (const step of REMAINING_STEP_ORDER) {
    const data = draft.steps[step];
    if (data === undefined) continue;

    try {
      const result = await post({ step, data, expertProfileId });
      if (!result.success) {
        return { outcome: 'failed', stepsFlushed, expertProfileId };
      }
      stepsFlushed += 1;
    } catch {
      return { outcome: 'failed', stepsFlushed, expertProfileId };
    }
  }

  return { outcome: 'flushed', stepsFlushed, expertProfileId };
}
