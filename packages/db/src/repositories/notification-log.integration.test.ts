import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { notificationLog } from '../schema';
import { userFactory } from '../test/factories';
import { notificationLogRepository } from './notification-log';
import { randomUUID } from 'crypto';

// ── insert ──────────────────────────────────────────────────────────

describe('notificationLogRepository.insert', () => {
  it('creates a notification log entry with all fields', async () => {
    const user = await userFactory({ firstName: 'Alice', lastName: 'Notify' });
    const correlationId = randomUUID();

    const row = await notificationLogRepository.insert({
      event: 'case.created',
      correlationId,
      recipientId: user.id,
      channel: 'email',
      template: 'case-created',
      status: 'sent',
      metadata: { caseId: '123' },
    });

    expect(row.id).toBeDefined();
    expect(row.event).toBe('case.created');
    expect(row.correlationId).toBe(correlationId);
    expect(row.recipientId).toBe(user.id);
    expect(row.channel).toBe('email');
    expect(row.template).toBe('case-created');
    expect(row.status).toBe('sent');
    expect(row.metadata).toEqual({ caseId: '123' });
    expect(row.error).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();
  });

  it('stores error text for failed notifications', async () => {
    const user = await userFactory({ firstName: 'Bob', lastName: 'Fail' });

    const row = await notificationLogRepository.insert({
      event: 'case.assigned',
      correlationId: randomUUID(),
      recipientId: user.id,
      channel: 'email',
      template: 'case-assigned',
      status: 'failed',
      error: 'SMTP connection refused',
    });

    expect(row.status).toBe('failed');
    expect(row.error).toBe('SMTP connection refused');
  });
});

// ── findByCorrelationId ─────────────────────────────────────────────

describe('notificationLogRepository.findByCorrelationId', () => {
  it('returns all logs for a correlation ID in desc order by createdAt', async () => {
    const user = await userFactory({ firstName: 'Corr', lastName: 'Test' });
    const correlationId = randomUUID();

    const first = await notificationLogRepository.insert({
      event: 'project.started',
      correlationId,
      recipientId: user.id,
      channel: 'email',
      template: 'project-started-client',
      status: 'sent',
    });

    const second = await notificationLogRepository.insert({
      event: 'project.started',
      correlationId,
      recipientId: user.id,
      channel: 'in_app',
      template: 'project-started-notification',
      status: 'sent',
    });

    const results = await notificationLogRepository.findByCorrelationId(correlationId);

    expect(results).toHaveLength(2);
    // Most recent first (desc order)
    expect(results[0]!.id).toBe(second.id);
    expect(results[1]!.id).toBe(first.id);
  });

  it('does not return logs for a different correlation ID', async () => {
    const user = await userFactory({ firstName: 'Iso', lastName: 'Test' });
    const correlationId1 = randomUUID();
    const correlationId2 = randomUUID();

    await notificationLogRepository.insert({
      event: 'case.created',
      correlationId: correlationId1,
      recipientId: user.id,
      channel: 'email',
      template: 'case-created',
      status: 'sent',
    });

    const results = await notificationLogRepository.findByCorrelationId(correlationId2);
    expect(results).toHaveLength(0);
  });
});

// ── findByRecipientId ───────────────────────────────────────────────

describe('notificationLogRepository.findByRecipientId', () => {
  it('returns all logs for a recipient in desc order by createdAt', async () => {
    const user = await userFactory({ firstName: 'Recv', lastName: 'Test' });

    await notificationLogRepository.insert({
      event: 'case.created',
      correlationId: randomUUID(),
      recipientId: user.id,
      channel: 'email',
      template: 'case-created',
      status: 'sent',
    });

    await notificationLogRepository.insert({
      event: 'case.assigned',
      correlationId: randomUUID(),
      recipientId: user.id,
      channel: 'email',
      template: 'case-assigned',
      status: 'sent',
    });

    await notificationLogRepository.insert({
      event: 'project.started',
      correlationId: randomUUID(),
      recipientId: user.id,
      channel: 'in_app',
      template: 'project-started',
      status: 'failed',
      error: 'Timeout',
    });

    const results = await notificationLogRepository.findByRecipientId(user.id);
    expect(results).toHaveLength(3);
    // Verify desc order by checking createdAt is non-increasing
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        results[i + 1]!.createdAt.getTime()
      );
    }
  });

  it('respects the limit parameter', async () => {
    const user = await userFactory({ firstName: 'Limit', lastName: 'Test' });

    for (let i = 0; i < 5; i++) {
      await notificationLogRepository.insert({
        event: `event.${i}`,
        correlationId: randomUUID(),
        recipientId: user.id,
        channel: 'email',
        template: `template-${i}`,
        status: 'sent',
      });
    }

    const results = await notificationLogRepository.findByRecipientId(user.id, 3);
    expect(results).toHaveLength(3);
  });

  it('does not return logs for a different recipient', async () => {
    const user1 = await userFactory({ firstName: 'User', lastName: 'One' });
    const user2 = await userFactory({ firstName: 'User', lastName: 'Two' });

    await notificationLogRepository.insert({
      event: 'case.created',
      correlationId: randomUUID(),
      recipientId: user1.id,
      channel: 'email',
      template: 'case-created',
      status: 'sent',
    });

    const results = await notificationLogRepository.findByRecipientId(user2.id);
    expect(results).toHaveLength(0);
  });
});

// ── soft-delete exclusion ───────────────────────────────────────────

describe('notification log soft-delete exclusion', () => {
  it('findByCorrelationId excludes soft-deleted logs', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'Del' });
    const correlationId = randomUUID();

    const row = await notificationLogRepository.insert({
      event: 'case.created',
      correlationId,
      recipientId: user.id,
      channel: 'email',
      template: 'case-created',
      status: 'sent',
    });

    // Soft-delete the log entry
    await db
      .update(notificationLog)
      .set({ deletedAt: new Date() })
      .where(eq(notificationLog.id, row.id));

    const results = await notificationLogRepository.findByCorrelationId(correlationId);
    expect(results).toHaveLength(0);
  });

  it('findByRecipientId excludes soft-deleted logs', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'Del2' });

    const row = await notificationLogRepository.insert({
      event: 'case.assigned',
      correlationId: randomUUID(),
      recipientId: user.id,
      channel: 'email',
      template: 'case-assigned',
      status: 'sent',
    });

    // Soft-delete the log entry
    await db
      .update(notificationLog)
      .set({ deletedAt: new Date() })
      .where(eq(notificationLog.id, row.id));

    const results = await notificationLogRepository.findByRecipientId(user.id);
    expect(results).toHaveLength(0);
  });
});
