/**
 * The stored side of invitations: reading the ones that wait, and tidying
 * the ones made before an invitation stood by itself. Kept apart from the
 * office service so that both it and the invite logic can use these.
 */
import type { Office, Permission } from "../model";
import type { InvitationView } from "../view";
import { all, get, run, transaction, type Db } from "./db";

export interface InviteRow {
  id: string;
  office_id: string;
  display_name: string;
  title: string;
  /** NULL when the role was removed while the invitation waited. */
  role_id: string | null;
  /** NULL when the room was removed while the invitation waited. */
  room_id: string | null;
  /** The person, once the invitation is accepted. */
  participant_id: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}

/** The invitations of one office that nobody has accepted yet, oldest first. */
export const waitingInvites = (db: Db, officeId: string): InviteRow[] =>
  all<InviteRow>(db, "SELECT * FROM invites WHERE office_id = ? AND accepted_at IS NULL ORDER BY created_at, id", officeId);

/** Why an invitation could not be accepted as it stands, or null when it could. */
export function inviteProblem(office: Office, row: InviteRow, now: number): string | null {
  if (row.expires_at <= now) return "The link has expired.";
  const role = row.role_id ? office.roles[row.role_id] : undefined;
  if (!role) return "The role it was for has been removed.";
  const room = office.floorplan.rooms.find((r) => r.id === row.room_id);
  if (!room || room.corridor) return "The room it was for has been removed.";
  return null;
}

/**
 * The waiting invitations as someone who may invite sees them. `reach` is
 * that person's own permissions: an invitation into a role that holds more
 * is shown, and is not theirs to change.
 */
export function invitationViews(db: Db, office: Office, reach: Permission[], now: number): InvitationView[] {
  return waitingInvites(db, office.id).map((row) => {
    const role = row.role_id ? office.roles[row.role_id] : undefined;
    return {
      id: row.id,
      displayName: row.display_name,
      title: row.title,
      roleName: role?.name ?? null,
      roomName: office.floorplan.rooms.find((r) => r.id === row.room_id)?.name ?? null,
      invitedBy: office.participants.find((p) => p.id === row.created_by)?.displayName ?? "Someone",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      problem: inviteProblem(office, row, now),
      manageable: (role?.permissions ?? []).every((p) => reach.includes(p)),
    };
  });
}

/**
 * An invitation used to add its person to the office at once, with a desk,
 * before they had accepted. Take those people out again, so that the
 * invitation alone is what waits. One whom the office's records already name,
 * or who somehow holds a sign-in, is left where they are: their invitation
 * still works and seats them at the desk they have.
 */
export function settleEarlyArrivals(db: Db): void {
  const early = all<{ id: string; participant_id: string }>(
    db,
    `SELECT i.id, i.participant_id
       FROM invites i
      WHERE i.accepted_at IS NULL AND i.participant_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.participant_id = i.participant_id)`,
  );
  for (const row of early) {
    try {
      transaction(db, () => {
        const desk = get<{ desk_id: string | null }>(db, "SELECT desk_id FROM participants WHERE id = ?", row.participant_id);
        run(db, "UPDATE invites SET participant_id = NULL WHERE id = ?", row.id);
        run(db, "DELETE FROM participants WHERE id = ?", row.participant_id);
        if (desk?.desk_id) run(db, "DELETE FROM desks WHERE id = ?", desk.desk_id);
      });
    } catch (error) {
      // Something still refers to the person, so they stay.
      if (!(error instanceof Error && /constraint/i.test(error.message))) throw error;
    }
  }
}
