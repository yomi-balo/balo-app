'use client';

import { CalendarX, CircleSlash, Hourglass } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  MEMBER_JOIN_NOT_OPEN_BODY,
  MEMBER_JOIN_NOT_OPEN_TITLE,
  MEMBER_JOIN_SETTING_UP_BODY,
  MEMBER_JOIN_SETTING_UP_TITLE,
  MEMBER_JOIN_UNAVAILABLE_BODY,
  MEMBER_JOIN_UNAVAILABLE_TITLE,
} from '@/lib/meetings/lobby';
import type { MemberJoinFailureReason } from '@/lib/meetings/member-join-failure';
import { JoinNoticeCard, JoinNoticeRetryButton } from './join-notice-card';

/**
 * BAL-581 — the three {@link MemberJoinFailureReason}s that render a member-worded notice
 * rather than an outage card (`outage`) or a session-sync redirect (`account_refused`).
 */
export type MemberJoinNoticeReason = Extract<
  MemberJoinFailureReason,
  'not_provisioned' | 'not_open' | 'unavailable'
>;

const MEMBER_JOIN_NOTICES: Readonly<
  Record<MemberJoinNoticeReason, { icon: LucideIcon; title: string; body: string }>
> = {
  not_provisioned: {
    icon: Hourglass,
    title: MEMBER_JOIN_SETTING_UP_TITLE,
    body: MEMBER_JOIN_SETTING_UP_BODY,
  },
  not_open: {
    icon: CalendarX,
    title: MEMBER_JOIN_NOT_OPEN_TITLE,
    body: MEMBER_JOIN_NOT_OPEN_BODY,
  },
  unavailable: {
    icon: CircleSlash,
    title: MEMBER_JOIN_UNAVAILABLE_TITLE,
    body: MEMBER_JOIN_UNAVAILABLE_BODY,
  },
};

/**
 * MEMBER ROUTE ONLY — never mount on a guest surface (the guest card is `JoinUnavailableNotice`,
 * propless by design). `onRetry` renders "Try again" and is passed only for `not_provisioned`,
 * the one reason the call page auto-retries (`isRetryableMemberJoinFailure`).
 */
export function MemberJoinNotice({
  reason,
  headingRef,
  onRetry,
}: Readonly<{
  reason: MemberJoinNoticeReason;
  headingRef?: React.Ref<HTMLHeadingElement>;
  onRetry?: () => void;
}>): React.JSX.Element {
  const { icon, title, body } = MEMBER_JOIN_NOTICES[reason];
  return (
    <JoinNoticeCard icon={icon} title={title} body={body} headingRef={headingRef}>
      {onRetry === undefined ? null : <JoinNoticeRetryButton onRetry={onRetry} />}
    </JoinNoticeCard>
  );
}
