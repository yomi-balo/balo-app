import { describe, it, expect } from 'vitest';
import type { SessionMoneyBlock } from '@/lib/meetings/recap-view-types';
import {
  resolveArtifacts,
  resolveMoneyView,
  resolveNotHeld,
  resolveRecapState,
} from './resolve-recap-state';

const READY_ARTIFACTS = resolveArtifacts({
  transcriptStatus: 'ready',
  summaryContent: 'We agreed to migrate the CPQ config.',
  transcriptContent: 'Amara: hello.',
  awaitingPipeline: false,
});

describe('resolveArtifacts', () => {
  it('renders both sections READY when both artefacts have content', () => {
    expect(READY_ARTIFACTS.summary.state).toBe('ready');
    expect(READY_ARTIFACTS.transcript.state).toBe('ready');
    expect(READY_ARTIFACTS.collapsed).toBe(false);
  });

  it('renders PROCESSING while the transcript row says so', () => {
    const out = resolveArtifacts({
      transcriptStatus: 'processing',
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(out.summary.state).toBe('processing');
    expect(out.transcript.state).toBe('processing');
    // A skeleton is a promise, not an absence — processing NEVER collapses.
    expect(out.collapsed).toBe(false);
  });

  it('renders PROCESSING when no transcript row exists but one is still plausible', () => {
    const out = resolveArtifacts({
      transcriptStatus: null,
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: true,
    });
    expect(out.summary.state).toBe('processing');
  });

  it('renders ABSENT when no transcript row exists and none is coming', () => {
    const out = resolveArtifacts({
      transcriptStatus: null,
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(out.summary.state).toBe('absent');
    expect(out.transcript.state).toBe('absent');
  });

  it('renders FAILED for a failed transcript, and collapses', () => {
    const out = resolveArtifacts({
      transcriptStatus: 'failed',
      summaryContent: 'ignored',
      transcriptContent: 'ignored',
      awaitingPipeline: false,
    });
    expect(out.summary.state).toBe('failed');
    expect(out.transcript.state).toBe('failed');
    expect(out.collapsed).toBe(true);
  });

  it('treats an EMPTY-STRING artefact as ABSENT, never as a ready-but-empty card', () => {
    const out = resolveArtifacts({
      transcriptStatus: 'ready',
      summaryContent: '',
      transcriptContent: '   ',
      awaitingPipeline: false,
    });
    expect(out.summary.state).toBe('absent');
    expect(out.summary.content).toBeNull();
    expect(out.transcript.state).toBe('absent');
    expect(out.collapsed).toBe(true);
  });

  it('COLLAPSES into ONE card when the summary AND the transcript are both non-ready', () => {
    const out = resolveArtifacts({
      transcriptStatus: 'ready',
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(out.collapsed).toBe(true);
  });

  it('does NOT collapse when only one of the two is missing', () => {
    const summaryOnly = resolveArtifacts({
      transcriptStatus: 'ready',
      summaryContent: 'Here is the summary.',
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(summaryOnly.collapsed).toBe(false);

    const transcriptOnly = resolveArtifacts({
      transcriptStatus: 'ready',
      summaryContent: null,
      transcriptContent: 'Amara: hello.',
      awaitingPipeline: false,
    });
    expect(transcriptOnly.collapsed).toBe(false);
  });
});

describe('resolveMoneyView — RULE M', () => {
  const PENDING: SessionMoneyBlock = {
    lens: 'client',
    state: 'pending',
    sessionId: 'session_1',
    durationMinutes: 0,
    amountAudMinor: 0,
    ratePerMinuteMinor: 333,
    settlementStatus: 'not_required',
    // BAL-412 — 0 while pending, unrelated to Rule M's own assertions.
    actualMinutes: 0,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  };
  const FINALIZED: SessionMoneyBlock = {
    lens: 'client',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    amountAudMinor: 15_000,
    ratePerMinuteMinor: 333,
    settlementStatus: 'not_required',
    finalizationPath: 'live_capture',
    // BAL-412 — a live_capture session: no presence settlement, no floor.
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  };

  it('M1 — NO credit_sessions row gives the absent branch, keyed on absence not on a policy', () => {
    expect(resolveMoneyView({ hasSession: false, block: null, elapsedMinutes: 0 })).toEqual({
      kind: 'absent',
    });
  });

  it('M2 — a PENDING row gives the shipped fragment, with the elapsed minutes', () => {
    expect(resolveMoneyView({ hasSession: true, block: PENDING, elapsedMinutes: 12 })).toEqual({
      kind: 'session',
      block: PENDING,
      elapsedMinutes: 12,
    });
  });

  it('M3 — a FINALIZED row gives the shipped fragment, figure passed straight through', () => {
    const out = resolveMoneyView({ hasSession: true, block: FINALIZED, elapsedMinutes: 45 });
    expect(out.kind).toBe('session');
    expect(out).toMatchObject({ block: { state: 'finalized' } });
  });

  it('a FAILED block fetch stays the SESSION branch with a null block, never the absent line', () => {
    // The fragment owns its own muted fallback. Reporting a fetch failure as
    // no-consultation-charge would be a different, and false, claim.
    expect(resolveMoneyView({ hasSession: true, block: null, elapsedMinutes: 3 })).toEqual({
      kind: 'session',
      block: null,
      elapsedMinutes: 3,
    });
  });
});

describe('resolveNotHeld', () => {
  const base = {
    expertPersonLabel: 'Amara @ CloudPeak',
    clientCompanyName: 'Northwind Industrial',
  };

  it('returns null for a meeting that was actually held', () => {
    expect(
      resolveNotHeld({ status: 'ended', outcome: 'completed', lens: 'client', ...base })
    ).toBeNull();
  });

  it('renders the cancelled arm (URL-reachable, so it cannot 500)', () => {
    const out = resolveNotHeld({ status: 'cancelled', outcome: null, lens: 'client', ...base });
    expect(out?.reason).toBe('cancelled');
    expect(out?.body).toMatch(/cancelled/i);
  });

  it('no_show_client on the CLIENT lens names the expert PERSON who waited', () => {
    const out = resolveNotHeld({
      status: 'ended',
      outcome: 'no_show_client',
      lens: 'client',
      ...base,
    });
    expect(out?.body).toBe('Amara @ CloudPeak joined and waited.');
  });

  it('no_show_client on the EXPERT lens names the client PARTY, never an individual', () => {
    const out = resolveNotHeld({
      status: 'ended',
      outcome: 'no_show_client',
      lens: 'expert',
      ...base,
    });
    expect(out?.body).toBe('No one from Northwind Industrial joined.');
  });

  it('missed_call on the CLIENT lens states the fact without blame', () => {
    const out = resolveNotHeld({
      status: 'ended',
      outcome: 'missed_call',
      lens: 'client',
      ...base,
    });
    expect(out?.body).toMatch(/wasn.t able to join/);
  });

  it('missed_call on the EXPERT lens NEVER tells the expert they failed', () => {
    const out = resolveNotHeld({
      status: 'ended',
      outcome: 'missed_call',
      lens: 'expert',
      ...base,
    });
    expect(out?.body).toMatch(/The call didn.t start/);
    expect(out?.body).not.toMatch(/you/i);
  });

  it('uses ONE shared headline across every cell, and never names the absentee', () => {
    const cells = [
      resolveNotHeld({ status: 'ended', outcome: 'no_show_client', lens: 'client', ...base }),
      resolveNotHeld({ status: 'ended', outcome: 'no_show_client', lens: 'expert', ...base }),
      resolveNotHeld({ status: 'ended', outcome: 'missed_call', lens: 'client', ...base }),
      resolveNotHeld({ status: 'ended', outcome: 'missed_call', lens: 'expert', ...base }),
      resolveNotHeld({ status: 'cancelled', outcome: null, lens: 'expert', ...base }),
    ];
    for (const cell of cells) {
      expect(cell?.headline).toMatch(/didn.t go ahead/);
      expect(cell?.headline).not.toMatch(/Amara|Northwind/);
    }
  });
});

describe('resolveRecapState — all six values', () => {
  const notHeld = (reason: 'no_show_client' | 'cancelled') => ({
    reason,
    headline: 'h',
    body: 'b',
  });

  it('cancelled', () => {
    expect(resolveRecapState({ notHeld: notHeld('cancelled'), artifacts: READY_ARTIFACTS })).toBe(
      'cancelled'
    );
  });

  it('not_held', () => {
    expect(
      resolveRecapState({ notHeld: notHeld('no_show_client'), artifacts: READY_ARTIFACTS })
    ).toBe('not_held');
  });

  it('ready', () => {
    expect(resolveRecapState({ notHeld: null, artifacts: READY_ARTIFACTS })).toBe('ready');
  });

  it('processing', () => {
    const artifacts = resolveArtifacts({
      transcriptStatus: 'processing',
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(resolveRecapState({ notHeld: null, artifacts })).toBe('processing');
  });

  it('artifacts_absent', () => {
    const artifacts = resolveArtifacts({
      transcriptStatus: null,
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(resolveRecapState({ notHeld: null, artifacts })).toBe('artifacts_absent');
  });

  it('artifacts_failed', () => {
    const artifacts = resolveArtifacts({
      transcriptStatus: 'failed',
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(resolveRecapState({ notHeld: null, artifacts })).toBe('artifacts_failed');
  });

  it('OUTCOME wins over ARTEFACTS — not-held is that, whatever its artefacts say', () => {
    const artifacts = resolveArtifacts({
      transcriptStatus: 'failed',
      summaryContent: null,
      transcriptContent: null,
      awaitingPipeline: false,
    });
    expect(resolveRecapState({ notHeld: notHeld('no_show_client'), artifacts })).toBe('not_held');
  });
});
