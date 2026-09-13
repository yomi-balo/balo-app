import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

// BAL-386 — read-only R2/S3 client for apps/api (the notification worker reads a
// client-facing proposal PDF by key at email-delivery time). Mirrors the apps/web
// wrapper's endpoint/credentials shape but WITHOUT `server-only` (that package is
// Next.js-only; apps/api is a Fastify service) and READ-ONLY (GetObject + HeadObject;
// BAL-254 fix round F1 added the HEAD — the same `Object Read` R2 token permission
// covers both, so no credential change is implied). R2 env vars must
// be provisioned on Railway (they are currently Vercel-only) for this to work in
// prod — see OQ-1.
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME ?? '';

/**
 * Read an R2 object's bytes by key. Throws when the object is missing or the body
 * is empty — the caller (email adapter) rethrows so BullMQ retries (the bytes are
 * guaranteed present by apps/web's force-generate at share time, so a miss is
 * transient).
 *
 * ⚠ BAL-254 fix round F6 — THE THROWN MESSAGE MUST NOT NAME THE KEY. Callers log
 * `error.message` into Axiom, and an r2Key is exactly what the BAL-254 plan's §12.10
 * forbids logging. The key is always known at the call site; the message is not the
 * place to carry it.
 */
export async function getR2ObjectBytes(key: string): Promise<Uint8Array> {
  const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const body = response.Body;
  if (!body) {
    throw new Error('R2 object has no body');
  }
  return body.transformToByteArray();
}

/**
 * The object's REAL size in bytes, straight from R2's own metadata.
 *
 * ⚠⚠ BAL-254 fix round F1 — THIS EXISTS BECAUSE A DECLARED SIZE IS NOT A SIZE. The
 * presigned PUT (`apps/web/src/lib/storage/project-document.ts`) carries no
 * `ContentLength` condition, and the confirm action's HEAD check is a SEPARATE
 * client-initiated call that an attacker simply never makes. So an object of any size
 * can sit under a key that genuinely belongs to its uploader while the row that names
 * it declares a kilobyte. Any caller that budgets memory against a client-supplied
 * `sizeBytes` must re-derive it here FIRST, before a single `GetObject`.
 *
 * Same message discipline as {@link getR2ObjectBytes}: never name the key.
 */
export async function headR2ObjectSize(key: string): Promise<number> {
  const response = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const contentLength = response.ContentLength;
  if (contentLength === undefined) {
    throw new Error('R2 object has no ContentLength');
  }
  return contentLength;
}
