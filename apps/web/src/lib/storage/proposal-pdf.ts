import 'server-only';

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';

/**
 * R2 object-cache seam for the client-facing proposal PDF (BAL-385). Unlike
 * {@link ./proposal-document}, this is NOT a per-file upload surface — it is a
 * read-through cache of a rendered artifact, keyed deterministically per
 * `proposalId`. The bytes are streamed through the AUTHORIZED download Route
 * Handler, never via `R2_PUBLIC_URL` (same privacy posture as proposal documents:
 * the PDF carries a specific client↔expert engagement's scope + marked-up pricing).
 *
 * Cache immutability: a proposal's CONTENT is immutable within its version, and a
 * revision creates a NEW `proposals` row (new id → new key), so the current
 * version always maps to a fresh key and no content-driven invalidation is needed.
 * The PDF's LAYOUT is not covered by that argument — the template can change under
 * an unchanged proposal id — so the key also carries
 * {@link PROPOSAL_PDF_LAYOUT_VERSION}.
 */

/** Key prefix every cached proposal PDF lives under. */
export const PROPOSAL_PDF_PREFIX = 'proposals/';

/**
 * Layout generation baked into the cache key. **Bump this whenever the rendered
 * PDF's layout changes.** The download route is a read-through cache, so without a
 * bump every proposal whose PDF was already generated would keep serving the OLD
 * layout forever. `v2` = BAL-392's four-cell summary box (replacing BAL-385's
 * two-item money/timeframe banner). Objects under a superseded version are
 * orphaned in R2; that is accepted — there is no purge job.
 */
export const PROPOSAL_PDF_LAYOUT_VERSION = 'v2';

/** Deterministic cache key for a proposal's client PDF: `proposals/{id}/client-v2.pdf`. */
export function proposalPdfKey(proposalId: string): string {
  return `${PROPOSAL_PDF_PREFIX}${proposalId}/client-${PROPOSAL_PDF_LAYOUT_VERSION}.pdf`;
}

/** True when an AWS/R2 error signals the object is simply absent (cache miss). */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * Read a cached proposal PDF from R2. Returns the bytes on a hit, or `null` on a
 * genuine cache MISS (`NoSuchKey` / 404). Prefix-guarded: a key outside the
 * proposal space is treated as a miss (never read arbitrary objects). All OTHER
 * errors (transient network / auth blips) RETHROW so the caller can decide to
 * regenerate rather than mask an outage as a permanent miss.
 */
export async function getProposalPdfFromR2(key: string): Promise<Uint8Array | null> {
  if (!key.startsWith(PROPOSAL_PDF_PREFIX)) {
    return null;
  }
  try {
    const result = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    if (result.Body === undefined) {
      return null;
    }
    return await result.Body.transformToByteArray();
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Write a rendered proposal PDF to R2. Prefix-guarded — refuses to write anything
 * outside the proposal space. The caller treats failure as non-fatal (logs +
 * still streams the in-memory buffer), so this surfaces errors by throwing and
 * lets the Route Handler own the catch.
 */
export async function putProposalPdfToR2(key: string, body: Uint8Array): Promise<void> {
  if (!key.startsWith(PROPOSAL_PDF_PREFIX)) {
    throw new Error(`Refusing to write key outside proposal PDF space: ${key}`);
  }
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/pdf',
    })
  );
}
