import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';

/**
 * BAL-424 (ADR-1045 §2 + ADR-1047) — the 10-minute DEBOUNCED unread digest. ONE component
 * serves both sides; the greeting differs via the per-recipient `firstName`.
 *
 * ⚠ IT COVERS MESSAGES **AND** FILE SHARES, ON ONE PROMISE. `conversation.message_posted`
 * and `conversation.file_shared` schedule the same event on the same dedupe key, so a
 * message plus a file inside one window arrives as ONE email. The two counts stay SEPARATE
 * rather than summed: "3 new messages and a file" is a materially different sentence from
 * "4 new things", and a file-only exchange (which previously produced an in-app notice and
 * no email ever) must read as a file share, not as a message.
 *
 * ⚠ THE CTA IS ANCHOR-AWARE. A `relationship` thread deep-links the project request; an
 * `engagement` thread deep-links the delivery workspace. A Case has no request at all, which
 * is the whole reason this event was re-anchored.
 *
 * ⚠ COUNTERPARTY CONCEALMENT (ADR-1044): `senderName` is a NAME. This template renders no
 * email address of any kind, and the payload carries none.
 *
 * Copy is gender-neutral and warm — a helpful nudge, never a countdown. No money figures.
 */
export interface ConversationUnreadDigestEmailProps {
  readonly firstName: string;
  /**
   * Author of the newest unread activity — a NAME, never an address. `null` when the window
   * coalesced MORE THAN ONE sender, in which case the copy names the THREAD rather than
   * misattributing everything to whoever happened to write last.
   */
  readonly senderName: string | null;
  /** Thread title: the request title, or the case title. */
  readonly title: string;
  readonly unreadMessageCount: number;
  readonly unreadFileCount: number;
  /** Newest unread MESSAGE preview. Rendered ONLY when `unreadMessageCount > 0`. */
  readonly preview?: string;
  /** Newest unread FILE name. Rendered ONLY when `unreadFileCount > 0`. */
  readonly fileName?: string;
  /** Where "Open the conversation" goes — already anchor-resolved by the registry. */
  readonly conversationUrl: string;
  readonly baseUrl: string;
}

const digestPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.16)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/** "1 new message" / "3 new messages" — empty string when there are none. */
function messagePhrase(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 new message' : `${count} new messages`;
}

/** "1 new file" / "3 new files" — empty string when there are none. */
function filePhrase(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 new file' : `${count} new files`;
}

/**
 * The headline sentence, from the two counts. Both zero cannot reach the template (the
 * fire-time recheck skips that publish), but it degrades to a truthful generic line rather
 * than an empty one.
 */
export function unreadDigestSummary(messageCount: number, fileCount: number): string {
  const parts = [messagePhrase(messageCount), filePhrase(fileCount)].filter(
    (part) => part.length > 0
  );
  if (parts.length === 0) return 'New activity';
  return parts.join(' and ');
}

export function ConversationUnreadDigestEmail({
  firstName = 'there',
  senderName,
  title,
  unreadMessageCount,
  unreadFileCount,
  preview,
  fileName,
  conversationUrl,
  baseUrl,
}: Readonly<ConversationUnreadDigestEmailProps>) {
  const summary = unreadDigestSummary(unreadMessageCount, unreadFileCount);
  /**
   * ⚠ THE CALLOUTS BRANCH ON THE COUNTS, NOT ON STRING PRESENCE. `preview` and `fileName`
   * describe the NEWEST unread activity, and only one of them is ever populated — so
   * rendering "X said …" merely because a preview string exists would put a message callout
   * under a "1 new file waiting for you." headline whenever the file leg won at fire time.
   * The count is the authority on what actually happened; the string is only its detail.
   */
  const showPreview = unreadMessageCount > 0 && preview !== undefined && preview.length > 0;
  const showFile = unreadFileCount > 0 && fileName !== undefined && fileName.length > 0;
  const previewText = senderName === null ? summary : `${summary} from ${senderName}`;
  // A coalesced window spanning two people names the THREAD, never one of them.
  const openingLine =
    senderName === null
      ? `There's new activity on "${title}". Here's the latest — pick it up whenever suits you.`
      : `${senderName} has been in touch about "${title}". Here's the latest — pick it up whenever suits you.`;
  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="New activity" style={digestPillStyle} />
        <Heading style={shared.smallHeroHeading}>{summary} waiting for you.</Heading>
        <Text style={shared.smallHeroSubtext}>{`On "${title}"`}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{openingLine}</Text>

        {showPreview ? (
          <Callout
            emoji="💬"
            heading={senderName === null ? 'Latest message' : `${senderName} said`}
            text={preview ?? ''}
            bg={colors.bg}
            borderColor={colors.border}
            headingColor={colors.text}
          />
        ) : null}

        {showFile ? (
          <Callout
            emoji="📎"
            heading="Shared with you"
            text={fileName ?? ''}
            bg={colors.bg}
            borderColor={colors.border}
            headingColor={colors.text}
          />
        ) : null}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={conversationUrl}>
            Open the conversation →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
