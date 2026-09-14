import {
  Calendar,
  Check,
  Clock,
  FileText,
  Lock,
  type LucideIcon,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Users,
} from 'lucide-react';

/**
 * ⚠⚠ WHY NUDGE DATA NAMES ITS ICON INSTEAD OF HOLDING ONE.
 *
 * `nudgeFor()` is evaluated in a SERVER component (`nudge-bar.tsx`, reached from
 * `request-detail-shell.tsx`) and its `primary`/`secondary` descriptors are handed to
 * `NudgeActions`, which is `'use client'`. A Lucide icon is a `forwardRef` object —
 * `{$$typeof: Symbol(react.forward_ref), render: fn}` — so carrying the component itself put a
 * function across the RSC boundary and the page died with:
 *
 *   Only plain objects can be passed to Client Components from Server Components.
 *     {label: ..., icon: {$$typeof: ..., render: ...}}
 *   Functions cannot be passed directly to Client Components ... {$$typeof: ..., render: function Users}
 *
 * A string token serializes; the component is resolved on whichever side renders it. Keep the
 * nudge tables declarative and free of anything non-serializable — that is the invariant this
 * module exists to hold, not merely a lookup convenience.
 */
export type NudgeIconName =
  | 'calendar'
  | 'check'
  | 'clock'
  | 'fileText'
  | 'lock'
  | 'messageSquare'
  | 'plus'
  | 'send'
  | 'sparkles'
  | 'users';

/**
 * Token → component. Exhaustive by `Record<NudgeIconName, LucideIcon>`, so adding a token
 * without a component is a type error rather than an `undefined` render.
 */
export const NUDGE_ICONS: Record<NudgeIconName, LucideIcon> = {
  calendar: Calendar,
  check: Check,
  clock: Clock,
  fileText: FileText,
  lock: Lock,
  messageSquare: MessageSquare,
  plus: Plus,
  send: Send,
  sparkles: Sparkles,
  users: Users,
};
