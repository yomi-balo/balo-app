import { Worker, type Job } from 'bullmq';
import { createRequire } from 'node:module';
import type { EntityType } from '@balo/db';

import { createRedisConnection } from '../lib/redis.js';
import { reconstructFormValues, registerBeneficiary } from '../services/airwallex/beneficiary.js';
import { AirwallexApiError } from '../services/airwallex/errors.js';

// ── Job data shape ──────────────────────────────────────────────

export interface VerifyBeneficiaryJobData {
  expertProfileId: string;
  expertName: string;
}

export const VERIFY_BENEFICIARY_QUEUE = 'verify-beneficiary';

// ── Worker ──────────────────────────────────────────────────────

export function startVerifyBeneficiaryWorker(): Worker<VerifyBeneficiaryJobData> {
  const worker = new Worker<VerifyBeneficiaryJobData>(
    VERIFY_BENEFICIARY_QUEUE,
    async (job: Job<VerifyBeneficiaryJobData>) => {
      // Lazy require — @balo/db is CJS; top-level createRequire breaks Vitest transforms
      const { payoutsRepository } = createRequire(import.meta.url)('@balo/db');

      const { expertProfileId, expertName } = job.data;

      // Fetch current payout details from DB
      const details = await payoutsRepository.findByExpertProfileId(expertProfileId);
      if (!details) {
        job.log('No payout details found — skipping');
        return;
      }

      // Skip if already verified
      if (details.beneficiaryStatus === 'verified' && details.airwallexBeneficiaryId) {
        job.log('Already verified — skipping');
        return;
      }

      const formValues = reconstructFormValues(details);
      const updatedAtMs = details.updatedAt.getTime();
      const entityType = (details.entityType as EntityType) ?? 'COMPANY';

      try {
        const result = await registerBeneficiary(
          formValues,
          expertName,
          expertProfileId,
          updatedAtMs,
          entityType
        );

        if (result.success) {
          await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
            airwallexBeneficiaryId: result.beneficiaryId,
            beneficiaryStatus: 'verified',
            beneficiaryRegisteredAt: new Date(),
          });
          job.log(`Beneficiary registered: ${result.beneficiaryId}`);
        } else {
          // 4xx validation error — do not retry
          await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
            beneficiaryStatus: 'invalid',
          });
          job.log(`Validation error: ${result.error}`);
        }
      } catch (err: unknown) {
        // 5xx or network error — check if this is the final attempt
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

        if (isLastAttempt) {
          // Keep pending_verification — outage ≠ invalid bank details
          // A future sweep or manual admin action can re-trigger registration
          job.log(`Final attempt failed — keeping pending_verification`);

          if (err instanceof AirwallexApiError) {
            job.log(`Airwallex error: ${err.status} — ${err.message}`);
          }
          return; // Don't re-throw on final attempt
        }

        // Re-throw to trigger BullMQ retry
        throw err;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  return worker;
}
