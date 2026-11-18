import 'server-only';

import { expertsRepository } from '@balo/db';
import { CALL_NOW_SCHEDULED_MINUTES } from '@balo/shared/meetings';
import { publicDisplayRatePerMinute } from '@balo/shared/pricing';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';
import { errorMessage, log } from '@/lib/logging';
import { canBookInPage } from './book-in-page';
import { getCallNowView } from './call-now-api-client';
import type {
  CallNowConfirmView,
  CallNowEntry,
  CallNowViewRead,
  CaseCallNowView,
} from './call-now-types';

/**
 * The case page's Call now read, shaped for the party card. The api decides what the viewer may
 * do (`GET /cases/:id/call-now` runs the same gates `POST` enforces); this only decides what to
 * show. Never throws: a failed hop means the entry is absent and the page is unbroken.
 */

/**
 * How long the case page waits for the Call now read. The balo-api client has no abort signal, so
 * the read is raced instead: a slow or hung api hides the entry rather than stalling the page.
 */
const READ_TIMEOUT_MS = 2500;

async function fetchCallNowView(engagementId: string): Promise<CallNowViewRead | null> {
  try {
    const result = await getCallNowView(engagementId);
    if (result.ok) return result.data;
    log.warn('Call now view unavailable — entry hidden', {
      engagementId,
      status: result.status,
      code: result.code,
    });
  } catch (error) {
    log.warn('Call now view read threw — entry hidden', {
      engagementId,
      error: errorMessage(error),
    });
  }
  return null;
}

/**
 * Starts the api read. Start it beside `loadCase` so it adds no wait; it never rejects and
 * resolves `null` once {@link READ_TIMEOUT_MS} has passed without an answer.
 */
export async function readCallNowView(engagementId: string): Promise<CallNowViewRead | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn('Call now view timed out — entry hidden', {
        engagementId,
        timeoutMs: READ_TIMEOUT_MS,
      });
      resolve(null);
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchCallNowView(engagementId), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** `A$x.xx/min · 15-minute minimum`, or `null` when the expert has no rate to quote. */
async function readRateLine(expertProfileId: string, engagementId: string): Promise<string | null> {
  try {
    const row = await expertsRepository.findRateCentsById(expertProfileId);
    const perMinute = publicDisplayRatePerMinute(row?.rateCents ?? null);
    if (perMinute === null) return null;
    return `A$${perMinute.toFixed(2)}/min · ${CALL_NOW_SCHEDULED_MINUTES}-minute minimum`;
  } catch (error) {
    log.warn('Call now rate read failed — confirm shows no rate', {
      engagementId,
      error: errorMessage(error),
    });
    return null;
  }
}

function entryFor(read: CallNowViewRead): CallNowEntry | null {
  if (read.canCallNow) return 'button';
  return read.reason;
}

async function buildConfirm(
  view: CaseSurfaceView,
  read: CallNowViewRead
): Promise<CallNowConfirmView> {
  if (view.lens !== 'client') {
    return { kind: 'expert_notice', engagementId: view.engagementId };
  }
  return {
    kind: 'client_terms',
    engagementId: view.engagementId,
    expertProfileId: view.expertProfileId,
    calleeOnline: read.calleeOnline,
    rateLine: await readRateLine(view.expertProfileId, view.engagementId),
    inPlaceCandidate: read.inPlaceCandidate,
    bookInPage: canBookInPage({
      lens: view.lens,
      isOpen: view.header.isOpen,
      hasPublicProfile: view.party.profileHref !== null,
    }),
  };
}

export async function loadCaseCallNow(input: {
  view: CaseSurfaceView;
  /** The pending `readCallNowView` for this case, started before `loadCase` resolved. */
  read: Promise<CallNowViewRead | null>;
}): Promise<CaseCallNowView | null> {
  const { view } = input;
  const read = await input.read;
  if (read === null) return null;
  const entry = entryFor(read);
  if (entry === null) return null;
  return {
    entry,
    calleeLabel: view.conversation.counterpartyFirstName,
    onlineBadge: view.lens === 'client' && read.calleeOnline,
    calleeTimeZone: entry === 'outside_hours' ? read.calleeTimeZone : null,
    confirm: entry === 'button' ? await buildConfirm(view, read) : null,
  };
}
