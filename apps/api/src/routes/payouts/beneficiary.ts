import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as baloDb from '@balo/db';
const { payoutsRepository } = baloDb;
import type { EntityType } from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { getQueue } from '../../lib/queue.js';
import {
  reconstructFormValues,
  registerBeneficiary,
} from '../../services/airwallex/beneficiary.js';
import { AirwallexApiError } from '../../services/airwallex/errors.js';
import {
  VERIFY_BENEFICIARY_QUEUE,
  type VerifyBeneficiaryJobData,
} from '../../jobs/verify-beneficiary.js';

// ── Validation ──────────────────────────────────────────────────

const bodySchema = z.object({
  expertProfileId: z.string().uuid(),
  expertName: z.string().min(1),
});

// ── Route ───────────────────────────────────────────────────────

export async function beneficiaryRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/payouts/beneficiary',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, expertName } = parsed.data;

      // Fetch payout details from DB
      const details = await payoutsRepository.findByExpertProfileId(expertProfileId);
      if (!details) {
        return reply.status(404).send({ error: 'Payout details not found' });
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
          // Airwallex accepted — mark verified
          await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
            airwallexBeneficiaryId: result.beneficiaryId,
            beneficiaryStatus: 'verified',
            beneficiaryRegisteredAt: new Date(),
          });

          return reply.send({
            success: true,
            beneficiaryId: result.beneficiaryId,
            beneficiaryStatus: 'verified',
          });
        }

        // 4xx validation error — mark invalid
        await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
          beneficiaryStatus: 'invalid',
        });

        return reply.status(422).send({
          success: false,
          beneficiaryStatus: 'invalid',
          airwallexFieldErrors: result.fieldErrors,
        });
      } catch (err: unknown) {
        // 5xx or network error — enqueue for background retry
        if (err instanceof AirwallexApiError) {
          request.log.warn(
            { status: err.status, expertProfileId },
            'Airwallex 5xx — enqueuing for retry'
          );
        } else {
          request.log.error(
            {
              expertProfileId,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            'Beneficiary registration failed — enqueuing for retry'
          );
        }

        await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
          beneficiaryStatus: 'pending_verification',
        });

        // Enqueue BullMQ job with exponential backoff
        try {
          const queue = getQueue(VERIFY_BENEFICIARY_QUEUE);
          await queue.add(
            'verify-beneficiary',
            { expertProfileId, expertName } satisfies VerifyBeneficiaryJobData,
            {
              jobId: `verify-beneficiary-${expertProfileId}-${updatedAtMs}`,
              attempts: 5,
              backoff: {
                type: 'exponential',
                delay: 30_000, // 30s, 60s, 120s, 240s, 480s
              },
            }
          );
        } catch (queueErr: unknown) {
          request.log.error(
            {
              expertProfileId,
              error: queueErr instanceof Error ? queueErr.message : String(queueErr),
            },
            'Failed to enqueue verify-beneficiary job'
          );
        }

        return reply.status(202).send({
          success: false,
          beneficiaryStatus: 'pending_verification',
          retryEnqueued: true,
        });
      }
    }
  );
}
