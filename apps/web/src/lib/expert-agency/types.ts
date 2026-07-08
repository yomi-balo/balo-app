/**
 * BAL-356 / ADR-1034 — client-safe expert→agency resolution types.
 *
 * ⚠️ CLIENT-BUNDLE FOOTGUN GUARD: this module is intentionally TYPE-ONLY and imports
 * NOTHING at runtime (no `@balo/db`, no server libs). It exists so the `'use client'`
 * `StepAgency` component can `import type { … }` the resolve/link contracts WITHOUT
 * dragging the `@balo/db` barrel (which pulls in `postgres` → `tls`) into the client
 * graph. The server-side resolver (`resolve-expert-agency.ts`) and orchestrator
 * (`link-expert-agency.ts`) re-import these same types, so there is a single source of
 * truth and no drift.
 */

/** The three determined resolution outcomes (advisory, decided by the read path). */
export type ExpertAgencyResolveKind = 'join' | 'provision' | 'solo';

/** Minimal agency summary surfaced to the JOIN card (no PII, no full row). */
export interface ResolvedAgencySummary {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * The read-only resolve result. `provision.name` is the suggested corporate name
 * (kept for audit/future use even though the design copy is generic).
 */
export type ResolveExpertAgencyResult =
  | { kind: 'join'; agency: ResolvedAgencySummary }
  | { kind: 'provision'; name: string }
  | { kind: 'solo' };

/**
 * The authoritative write outcome — a superset of the resolve kinds plus the
 * idempotent `already_linked` no-op (resume / double-click).
 */
export type LinkExpertAgencyOutcome = 'join' | 'provision' | 'solo' | 'already_linked';

/** The write Server Action's discriminated result contract (fails closed). */
export type LinkExpertAgencyActionResult =
  | { success: true; outcome: LinkExpertAgencyOutcome; agencyId: string }
  | { success: false; error: string };
