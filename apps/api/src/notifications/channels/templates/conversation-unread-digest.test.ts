import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import {
  ConversationUnreadDigestEmail,
  unreadDigestSummary,
} from './conversation-unread-digest.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  senderName: 'Priya',
  title: 'Salesforce CPQ',
  unreadMessageCount: 3,
  unreadFileCount: 0,
  preview: 'Are you keeping Zendesk?',
  conversationUrl: `${BASE}/engagements/eng-1`,
  baseUrl: BASE,
  ...over,
});

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
}

/**
 * ⚠ THE TWO COUNTS ARE NEVER SUMMED. "3 new messages and a file" is a materially different
 * sentence from "4 new things", and a file-only exchange must read as a file share.
 */
describe('unreadDigestSummary', () => {
  it.each([
    [1, 0, '1 new message'],
    [3, 0, '3 new messages'],
    [0, 1, '1 new file'],
    [0, 2, '2 new files'],
    [3, 1, '3 new messages and 1 new file'],
  ])('(%i messages, %i files) → %s', (messages, files, expected) => {
    expect(unreadDigestSummary(messages, files)).toBe(expected);
  });

  it('degrades to a truthful generic line rather than an empty one', () => {
    // The fire-time recheck skips a both-zero publish, so this is unreachable in production —
    // it exists so a removed guard cannot produce an empty subject line.
    expect(unreadDigestSummary(0, 0)).toBe('New activity');
  });
});

describe('ConversationUnreadDigestEmail (BAL-424)', () => {
  it('greets by first name, names the thread, and links the anchor-resolved CTA', async () => {
    const html = clean(await render(ConversationUnreadDigestEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Salesforce CPQ');
    expect(html).toContain('/engagements/eng-1');
    expect(html).toContain('3 new messages waiting for you.');
  });

  it('renders the message preview callout, attributed to the sender', async () => {
    const html = clean(await render(ConversationUnreadDigestEmail(props())));
    expect(html).toContain('Priya said');
    expect(html).toContain('Are you keeping Zendesk?');
  });

  /** The regression the 2026-08-11 ruling exists to fix: a file-only exchange still sends. */
  it('renders the FILE callout and no message preview on a file-only exchange', async () => {
    const html = clean(
      await render(
        ConversationUnreadDigestEmail(
          props({
            unreadMessageCount: 0,
            unreadFileCount: 1,
            preview: undefined,
            fileName: 'price-book.xlsx',
          })
        )
      )
    );
    expect(html).toContain('Shared with you');
    expect(html).toContain('price-book.xlsx');
    expect(html).not.toContain('Priya said');
    expect(html).toContain('1 new file waiting for you.');
  });

  it('renders BOTH callouts for a coalesced message + file window', async () => {
    const html = clean(
      await render(
        ConversationUnreadDigestEmail(props({ unreadFileCount: 1, fileName: 'notes.pdf' }))
      )
    );
    expect(html).toContain('Priya said');
    expect(html).toContain('notes.pdf');
    expect(html).toContain('3 new messages and 1 new file waiting for you.');
  });

  /**
   * ⚠ THE CALLOUTS BRANCH ON THE COUNTS, NOT ON STRING PRESENCE. `preview` and `fileName`
   * describe the NEWEST unread activity and only one is ever populated, so a leftover string
   * must never summon a callout the counts do not support.
   */
  it('renders no message callout when the message count is zero, whatever preview holds', async () => {
    const html = clean(
      await render(
        ConversationUnreadDigestEmail(
          props({
            unreadMessageCount: 0,
            unreadFileCount: 1,
            preview: 'a stale preview that outlived its rebuild',
            fileName: 'price-book.xlsx',
          })
        )
      )
    );
    expect(html).toContain('1 new file waiting for you.');
    expect(html).not.toContain('Priya said');
    expect(html).not.toContain('a stale preview that outlived its rebuild');
    expect(html).toContain('price-book.xlsx');
  });

  it('renders no file callout when the file count is zero, whatever fileName holds', async () => {
    const html = clean(
      await render(
        ConversationUnreadDigestEmail(props({ unreadFileCount: 0, fileName: 'stale.pdf' }))
      )
    );
    expect(html).not.toContain('Shared with you');
    expect(html).not.toContain('stale.pdf');
  });

  /** A coalesced window spanning two people names the THREAD, never one of them. */
  it('names the thread instead of a person when senderName is null', async () => {
    const html = clean(await render(ConversationUnreadDigestEmail(props({ senderName: null }))));
    expect(html).toContain('new activity on');
    expect(html).toContain('Salesforce CPQ');
    expect(html).toContain('Latest message');
    expect(html).not.toContain('Priya');
  });

  /** ADR-1044: names cross the party boundary, EMAIL ADDRESSES NEVER. */
  it('carries no email address anywhere in the rendered body', async () => {
    const html = clean(await render(ConversationUnreadDigestEmail(props())));
    // `support@getbalo.com` (the shell's footer) is the ONLY address the page may contain.
    // The bounded `[\w.-]{1,64}` local part cannot backtrack catastrophically (S5852).
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
  });
});

describe('conversation-unread-digest registry entry', () => {
  it('deep-links the ENGAGEMENT arm and names the sender in the subject', () => {
    const result = getEmailTemplate('conversation-unread-digest', {
      recipientName: 'Dana',
      senderName: 'Priya',
      title: 'Salesforce CPQ',
      unreadMessageCount: 2,
      unreadFileCount: 0,
      preview: 'hello',
      contextType: 'engagement',
      engagementId: 'eng-1',
    });
    expect(result?.subject).toBe('2 new messages from Priya');
  });

  it('deep-links the RELATIONSHIP arm to the project request', async () => {
    const result = getEmailTemplate('conversation-unread-digest', {
      recipientName: 'Dana',
      senderName: 'Priya',
      title: 'CPQ implementation',
      unreadMessageCount: 0,
      unreadFileCount: 1,
      fileName: 'x.pdf',
      contextType: 'relationship',
      projectRequestId: 'req-1',
    });
    expect(result).toBeDefined();
    const html = clean(await render(result!.component));
    expect(html).toContain('/projects/req-1');
    expect(result!.subject).toBe('1 new file from Priya');
  });

  /**
   * ⚠ A NULL `senderName` IS A DELIBERATE CONTRACT VALUE (the window coalesced more than one
   * sender), NOT a missing field — the subject must name the THREAD rather than invent an
   * attribution like "Someone".
   */
  it('subjects a multi-sender digest on the thread, never on a fabricated name', () => {
    const result = getEmailTemplate('conversation-unread-digest', {
      recipientName: 'Dana',
      senderName: null,
      title: 'Salesforce CPQ',
      unreadMessageCount: 3,
      unreadFileCount: 1,
      preview: 'hello',
      fileName: 'x.pdf',
      contextType: 'engagement',
      engagementId: 'eng-1',
    });
    expect(result?.subject).toBe('3 new messages and 1 new file on Salesforce CPQ');
    expect(result?.subject).not.toContain('Someone');
  });
});
