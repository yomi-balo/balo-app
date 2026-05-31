'use server';

import 'server-only';

import { z } from 'zod';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';

/**
 * BAL-239 dev-only seeding Server Actions.
 *
 * Each action: prod-guarded, Zod-validated, proxies to the Fastify
 * `/dev/seed/*` endpoint via `loggedFetch` with the internal API key. The
 * Fastify routes themselves are not registered in production, so this is a
 * belt-and-suspenders second gate.
 */

const API_BASE_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const API_KEY = process.env.INTERNAL_API_SECRET ?? '';

// ── Response shapes (mirror the API summaries 1:1) ─────────────────

export interface RegenerateSummary {
  ok: true;
  expertsGenerated: number;
  skillsGenerated: number;
  languagesGenerated: number;
  industriesGenerated: number;
  seedUsedRng: number;
  baselineAt: string;
}

export interface RefreshSummary {
  ok: true;
  availabilityRulesGenerated: number;
  consultationsSeeded: number;
  consultationsCancelled: number;
  cacheRowsWritten: number;
  expertsWithEarliest: number;
  expertsNullEarliest: number;
  baselineAt: string;
  seedUsedRng: number;
}

export interface ResetSummary {
  ok: true;
  experts: RegenerateSummary;
  availability: RefreshSummary;
}

export type SeedActionResult<T> = { success: true; data: T } | { success: false; error: string };

// ── Input validation ───────────────────────────────────────────────

const regenerateInputSchema = z.object({
  count: z.number().int().min(1).max(500).optional(),
  seed: z.number().int().optional(),
});

const refreshInputSchema = z.object({
  now: z.string().min(1).optional(),
  seed: z.number().int().optional(),
});

const resetInputSchema = z.object({
  count: z.number().int().min(1).max(500).optional(),
  now: z.string().min(1).optional(),
  seed: z.number().int().optional(),
});

export type RegenerateInput = z.infer<typeof regenerateInputSchema>;
export type RefreshInput = z.infer<typeof refreshInputSchema>;
export type ResetInput = z.infer<typeof resetInputSchema>;

// ── Shared proxy ────────────────────────────────────────────────────

async function callSeedEndpoint<T>(
  path: string,
  body: Record<string, unknown>,
  service: string
): Promise<SeedActionResult<T>> {
  if (process.env.NODE_ENV === 'production') {
    return { success: false, error: 'Seeding is not available in production.' };
  }

  try {
    const response = await loggedFetch(`${API_BASE_URL}${path}`, {
      service,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      const message = errorBody.error ?? `Seed API returned ${response.status}`;
      log.error('Seed action failed', { path, status: response.status, error: message });
      return { success: false, error: message };
    }

    const data = (await response.json()) as T;
    return { success: true, data };
  } catch (error) {
    log.error('Seed action threw', {
      path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Failed to reach the seed API. Is the API running?' };
  }
}

// ── Actions ─────────────────────────────────────────────────────────

export async function regenerateExpertsAction(
  input: RegenerateInput
): Promise<SeedActionResult<RegenerateSummary>> {
  const parsed = regenerateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  return callSeedEndpoint<RegenerateSummary>('/dev/seed/experts', parsed.data, 'seed-experts');
}

export async function refreshAvailabilityAction(
  input: RefreshInput
): Promise<SeedActionResult<RefreshSummary>> {
  const parsed = refreshInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  return callSeedEndpoint<RefreshSummary>(
    '/dev/seed/availability',
    parsed.data,
    'seed-availability'
  );
}

export async function fullResetAction(input: ResetInput): Promise<SeedActionResult<ResetSummary>> {
  const parsed = resetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  return callSeedEndpoint<ResetSummary>('/dev/seed/reset', parsed.data, 'seed-reset');
}
