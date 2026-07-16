import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

// BAL-386 — read-only R2/S3 client for apps/api (the notification worker reads a
// client-facing proposal PDF by key at email-delivery time). Mirrors the apps/web
// wrapper's endpoint/credentials shape but WITHOUT `server-only` (that package is
// Next.js-only; apps/api is a Fastify service) and GetObject-only. R2 env vars must
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
 */
export async function getR2ObjectBytes(key: string): Promise<Uint8Array> {
  const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const body = response.Body;
  if (!body) {
    throw new Error(`R2 object has no body: ${key}`);
  }
  return body.transformToByteArray();
}
