import { z } from 'zod';
import {
  projectRequestsRepository,
  proposalsRepository,
  type Proposal,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import {
  getProposalPdfFromR2,
  putProposalPdfToR2,
  proposalPdfKey,
} from '@/lib/storage/proposal-pdf';
import {
  generateClientProposalPdf,
  proposalPdfFileName,
} from '@/lib/project-request/proposal/pdf/ensure-client-pdf';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';

// react-pdf + the R2 (S3) client need Node, not Edge.
export const runtime = 'nodejs';
// Authorized, per-viewer content — never statically cached.
export const dynamic = 'force-dynamic';

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** Both path params are Postgres `uuid` columns — reject non-UUIDs before any query. */
const uuidParam = z.string().uuid();

interface AuthorizedProposal {
  status: 'ok';
  request: ProjectRequestWithRelations;
  relationship: Relationship;
  proposal: Proposal;
  lens: 'client' | 'admin';
}

/** A deny outcome carries the HTTP status the Route Handler should return. */
type DownloadTarget = AuthorizedProposal | { status: 403 | 404 };

function errorFields(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * Resolve + authorize the proposal behind this URL. Mirrors the proposal page's
 * gate, but 404s (no existence leak) instead of redirecting:
 *  - missing request / unauthorized lens / relationship not on request → 404
 *  - EXPERT lens (even on their own relationship) → 403 (the client PDF is never
 *    served to the expert lens)
 *  - no current proposal / `draft` status → 404 (gate is `status !== 'draft'`;
 *    `submittedAt` is NOT gated on — it defaults to now() even on drafts)
 */
async function loadAuthorizedProposal(
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
  requestId: string,
  relationshipId: string
): Promise<DownloadTarget> {
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (!request) {
    return { status: 404 };
  }
  const ctx = resolveRequestLens(user, request);
  if (ctx === null) {
    return { status: 404 };
  }
  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined) {
    return { status: 404 };
  }
  if (ctx.lens === 'expert') {
    return { status: 403 };
  }
  const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (proposal === undefined || proposal.status === 'draft') {
    return { status: 404 };
  }
  return { status: 'ok', request, relationship, proposal, lens: ctx.lens };
}

/**
 * Read-through cache: return the stored bytes on a hit; otherwise generate,
 * best-effort upload (failure is logged, never blocks the response), and return
 * the freshly-rendered bytes. A non-not-found cache READ error is a transient
 * blip — log + regenerate rather than 500.
 */
async function resolveBytes(
  target: AuthorizedProposal,
  key: string,
  userId: string
): Promise<Uint8Array> {
  const { proposal, relationship } = target;
  let cached: Uint8Array | null = null;
  try {
    cached = await getProposalPdfFromR2(key);
  } catch (error) {
    log.warn('Proposal client PDF cache read failed; regenerating', {
      proposalId: proposal.id,
      key,
      ...errorFields(error),
    });
  }
  if (cached !== null) {
    return cached;
  }

  const generated = await generateClientProposalPdf(target);
  log.info('Proposal client PDF generated', {
    proposalId: proposal.id,
    relationshipId: relationship.id,
    version: proposal.version,
    audience: 'client',
    userId,
  });
  try {
    await putProposalPdfToR2(key, generated);
  } catch (error) {
    log.error('Proposal client PDF upload to R2 failed', {
      proposalId: proposal.id,
      key,
      ...errorFields(error),
    });
  }
  return generated;
}

function pdfResponse(body: Uint8Array, title: string, version: number): Response {
  // Copy into a fresh ArrayBuffer-backed view so the bytes satisfy `BodyInit`
  // (a Node Buffer / R2 `Uint8Array<ArrayBufferLike>` is not directly assignable).
  const bytes = new Uint8Array(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${proposalPdfFileName(title, version)}"`,
      'Content-Length': String(bytes.byteLength),
      // Authorized private content — never shared/proxy-cached; R2 is the server cache.
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * GET the Balo-branded, client-facing proposal PDF. Auth → lens/status gate →
 * read-through R2 cache → stream. Emits `project_proposal_pdf_downloaded` on a
 * successful response (hit or miss). The `audience` property records WHO
 * downloaded (client|admin); the serializer that builds the PDF always uses the
 * `client` audience.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestId: string; relationshipId: string }> }
): Promise<Response> {
  const { requestId, relationshipId } = await params;

  // A malformed (non-UUID) id can never match a row — reject it up front. Passing it
  // into an `eq()` on a uuid column makes Postgres throw (a generic 500 + Sentry
  // noise). Mirror the not-found 404 exactly (never leak whether the id exists).
  if (!uuidParam.safeParse(requestId).success || !uuidParam.safeParse(relationshipId).success) {
    return new Response(null, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) {
    // A fetch/anchor endpoint, not a page — 401 rather than redirect to /login.
    return new Response(null, { status: 401 });
  }

  let target: DownloadTarget;
  try {
    target = await loadAuthorizedProposal(user, requestId, relationshipId);
  } catch (error) {
    log.error('Proposal client PDF gate resolution failed', {
      requestId,
      relationshipId,
      userId: user.id,
      ...errorFields(error),
    });
    return new Response('Failed to generate proposal PDF', { status: 500 });
  }

  if (target.status !== 'ok') {
    return new Response(target.status === 403 ? 'Forbidden' : null, { status: target.status });
  }

  const { proposal, request, lens } = target;
  const key = proposalPdfKey(proposal.id);

  let body: Uint8Array;
  try {
    body = await resolveBytes(target, key, user.id);
  } catch (error) {
    log.error('Proposal client PDF generation failed', {
      proposalId: proposal.id,
      relationshipId,
      userId: user.id,
      ...errorFields(error),
    });
    return new Response('Failed to generate proposal PDF', { status: 500 });
  }

  trackServerAndFlush(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_PDF_DOWNLOADED, {
    proposal_id: proposal.id,
    version: proposal.version,
    audience: lens === 'admin' ? 'admin' : 'client',
    distinct_id: user.id,
  });

  return pdfResponse(body, request.title, proposal.version);
}
