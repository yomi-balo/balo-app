import 'server-only';

import {
  internalNotesRepository,
  usersRepository,
  type ProjectRequestWithRelations,
  type InternalNoteWithAuthor,
} from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import type { SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { deriveInitials } from '@/lib/format/initials';

/** Rendered "who wrote this note" name, plus everything the trash-icon gate needs. */
export interface InternalNoteView {
  id: string;
  /** "Adeeb" / "A team member" — never an email, never a role. */
  authorName: string;
  authorInitials: string;
  body: string;
  createdAtIso: string;
  /** Resolved SERVER-SIDE, per note (D2) — `canDeleteAnyNote || note.authorUserId === user.id`. */
  canDelete: boolean;
}

export interface BaloPanelView {
  owner: { userId: string; name: string } | null;
  /** [] when the viewer cannot assign — the panel never fetches a roster it can't use. */
  staff: Array<{ userId: string; name: string }>;
  /** [] when the viewer cannot read notes — `MANAGE_INTERNAL_NOTES` gates the READ too. */
  notes: InternalNoteView[];
  canAssignOwner: boolean;
  canWriteNotes: boolean;
  canDeleteAnyNote: boolean;
}

const UNKNOWN_STAFF_NAME = 'A team member';

type StaffRow = Awaited<ReturnType<typeof usersRepository.listPlatformStaff>>[number];

/**
 * Server loader for the "Balo" staff panel (BAL-541) — who owns this request, and the
 * staff-internal notebook. Returns `null` when the viewer holds NEITHER surface token: the
 * panel does not exist for them, not merely "empty" — `RequestDetailShell` keys its layout off
 * this null-ness, never off lens/archetype (D5).
 *
 * ⚠ `owner`/`notes` live ONLY on this view, never on `RequestDetailView` or `PortfolioRowView`
 * — D9's leak invariant is a statement about types that structurally lack these fields.
 *
 * ⚠ NO ROLE RE-FILTER on the owner's name (D7) — a demoted past owner still displays. The
 * picker's "prepend the absent current owner" behaviour is CLIENT logic (`balo-panel.tsx`), not
 * this loader's.
 *
 * Let a throw here reach `error.tsx` — the `loadAdminKickoffBilling` posture, no swallow.
 */
export async function loadBaloPanel(
  user: SessionUser,
  request: ProjectRequestWithRelations
): Promise<BaloPanelView | null> {
  const canAssignOwner = hasPlatformCapability(
    user,
    PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER
  );
  const canWriteNotes = hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES);
  const canDeleteAnyNote = hasPlatformCapability(
    user,
    PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE
  );

  if (!canAssignOwner && !canWriteNotes) return null;

  const ownerUserId = request.baloOwnerUserId;

  const [notes, staffRows, ownerNames] = await Promise.all([
    canWriteNotes
      ? internalNotesRepository.listForEntity({
          entityType: 'project_request',
          entityId: request.id,
        })
      : Promise.resolve<InternalNoteWithAuthor[]>([]),
    canAssignOwner ? usersRepository.listPlatformStaff() : Promise.resolve<StaffRow[]>([]),
    // `findNamesByIds` short-circuits to `[]` on empty input — no query when unassigned.
    usersRepository.findNamesByIds(ownerUserId === null ? [] : [ownerUserId]),
  ]);

  const [ownerRow] = ownerNames;
  const owner =
    ownerUserId === null
      ? null
      : {
          userId: ownerUserId,
          // A soft-deleted owner resolves to no row → the picker is never silently blank.
          name:
            ownerRow === undefined
              ? UNKNOWN_STAFF_NAME
              : personDisplayName(ownerRow.firstName, ownerRow.lastName, UNKNOWN_STAFF_NAME),
        };

  return {
    owner,
    staff: staffRows.map((s) => ({
      userId: s.id,
      name: personDisplayName(s.firstName, s.lastName, UNKNOWN_STAFF_NAME),
    })),
    notes: notes.map((note) => {
      const authorName = personDisplayName(
        note.authorFirstName,
        note.authorLastName,
        UNKNOWN_STAFF_NAME
      );
      return {
        id: note.id,
        authorName,
        authorInitials: deriveInitials(authorName),
        body: note.body,
        createdAtIso: note.createdAt.toISOString(),
        canDelete: canDeleteAnyNote || note.authorUserId === user.id,
      };
    }),
    canAssignOwner,
    canWriteNotes,
    canDeleteAnyNote,
  };
}
