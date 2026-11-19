import type { CallNowFundingCode } from '@/lib/call-now/call-now-types';

/**
 * Why `startCallNowAction` did not start a call. `funding` carries the api's refusal literal so
 * the dialog can open the funding step; every other code maps to one toast sentence.
 */
export type StartCallNowFailureCode =
  | 'impersonation_refused'
  | 'invalid'
  | 'session_expired'
  | 'unavailable'
  | 'in_place_not_eligible'
  | 'funding'
  | 'funding_unavailable'
  | 'venue_unavailable'
  | 'rate_limited'
  | 'failed';

/** Every failure that carries no funding detail: one toast sentence each. */
export type StartCallNowPlainFailureCode = Exclude<StartCallNowFailureCode, 'funding'>;

export type StartCallNowResult =
  | { ok: true; meetingId: string; ringId: string }
  | {
      ok: false;
      code: 'funding';
      fundingCode: CallNowFundingCode;
    }
  | { ok: false; code: StartCallNowPlainFailureCode };
