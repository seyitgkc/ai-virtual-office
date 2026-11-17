/**
 * Inviting a person into the office.
 *
 * Someone whose role may invite names the person, their title, a role and a
 * room. That makes an invitation and a single-use link. Nobody is added to
 * the office yet: the invitation waits, and can be given a new link or
 * withdrawn. The invited person opens the link and chooses their own email
 * and password, so nobody else ever handles their credentials, and only then
 * do they get a desk and a seat. Only a hash of the link's token is stored,
 * which is why a lost link is replaced with a new one and never shown again.
 *
 * The demo office is entered without a password, by anyone. A person added
 * there gets the same password-free entry as its seeded people and no link,
 * so the demo never hands out an account that can hold offices of its own.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { freeDeskSpot } from "../geometry";
import type { Desk, Office, Participant, Role, Room } from "../model";
import { may } from "../model";
import {
  addMembership,
  authenticate,
  createUser,
  issueSession,
  passwordProblem,
  seatsOf,
  sha256,
  userByEmail,
  userByParticipant,
  type Session,
  type User,
} from "./auth";
import { get, run, transaction, type Db } from "./db";
import { inviteProblem, waitingInvites, type InviteRow } from "./inviteRows";
import { ensureDemoAccounts, inTurn, isDemoOffice, OfficeError, officeDatabase, recordAudit } from "./officeService";
import { loadEngineState, writeDesk, writeParticipant } from "./officeStore";

const INVITE_DAYS = 7;
const MAX_WAITING = 20;
const COLOURS = ["#5b8a72", "#4f7fa8", "#a8744f", "#7d6aa8", "#a85f7a", "#6a8f3f", "#3f8f8a"];

export interface InviteRequest {
  displayName: string;
  title: string;
  roleId: string;
  roomId: string;
}

/** The office a signed-in person is in, and that person, if their role may invite. */
function asInviter(session: Session): { db: Db; office: Office; now: number; inviter: Participant } {
  const db = officeDatabase();
  const state = session.officeId ? loadEngineState(db, session.officeId) : null;
  const inviter = state?.office.participants.find((p) => p.id === session.participantId);
  if (!state || !inviter) throw new OfficeError(404, "You are not in an office.");
  if (!may(state.office, inviter, "invite_people")) {
    throw new OfficeError(403, "Your role does not have the permission to invite people.");
  }
  return { db, office: state.office, now: state.now, inviter };
}

/** Nobody hands out more than they hold: the role must carry no permission the inviter lacks. */
function withinReach(office: Office, inviter: Participant, role: Role): boolean {
  const own = office.roles[inviter.roleId]?.permissions ?? [];
  return role.permissions.every((p) => own.includes(p));
}

/** A new person at a free spot in the room, or a refusal when the room has none. */
function seatFor(
  office: Office,
  room: Room,
  role: Role,
  displayName: string,
  title: string,
): { desk: Desk; participant: Participant } {
  const spot = freeDeskSpot(office.floorplan, room.id);
  if (!spot) throw new OfficeError(409, `${room.name} has no space for another desk.`);
  const suffix = randomUUID().slice(0, 8);
  const desk: Desk = { id: `desk-${suffix}`, roomId: room.id, position: spot, facing: 0, occupantId: `p-${suffix}` };
  const participant: Participant = {
    id: `p-${suffix}`,
    kind: "human",
    displayName,
    title,
    roleId: role.id,
    deskId: desk.id,
    capabilities: [],
    backing: null,
    agentType: null,
    providerId: null,
    model: null,
    playbook: [],
    appearance: { color: COLOURS[office.participants.length % COLOURS.length] },
  };
  return { desk, participant };
}

const newLink = (): { token: string; expiresAt: number } => ({
  token: randomBytes(32).toString("base64url"),
  expiresAt: Date.now() + INVITE_DAYS * 86_400_000,
});

/** `path` is the invite link to send, or null in the demo office, which is entered without one. */
export function createInvite(session: Session, request: InviteRequest): { path: string | null; expiresAt: number | null } {
  const { db, office, now, inviter } = asInviter(session);

  const displayName = request.displayName.trim();
  const title = request.title.trim();
  if (displayName.length < 2 || displayName.length > 60) throw new OfficeError(400, "Enter the person's name.");
  if (title.length < 2 || title.length > 60) throw new OfficeError(400, "Enter the person's job title.");
  const role = office.roles[request.roleId];
  if (!role) throw new OfficeError(400, "Choose a role.");
  if (!withinReach(office, inviter, role)) {
    throw new OfficeError(403, `You can only invite into a role whose permissions you hold yourself. ${role.name} has more.`);
  }
  const room = office.floorplan.rooms.find((r) => r.id === request.roomId);
  if (!room) throw new OfficeError(400, "Choose a room.");
  if (room.corridor) throw new OfficeError(400, `Nobody has a desk in ${room.name}, which is only for walking through.`);
  if (!freeDeskSpot(office.floorplan, room.id)) throw new OfficeError(409, `${room.name} has no space for another desk.`);

  // The demo office has no passwords and so nothing to wait for: the person is there at once.
  if (isDemoOffice(office.id)) {
    const { desk, participant } = seatFor(office, room, role, displayName, title);
    transaction(db, () => {
      writeDesk(db, desk);
      writeParticipant(db, office.id, participant);
      ensureDemoAccounts(db, { ...office, participants: [participant] });
      recordAudit(db, {
        officeId: office.id,
        officeClock: now,
        actorId: inviter.id,
        actionType: "INVITE",
        subject: { taskId: null, subjectParticipantId: participant.id, ruleId: null, roomId: room.id },
        notes: [`${inviter.displayName} added ${displayName} as ${role.name}, with a desk in ${room.name}`],
      });
    });
    return { path: null, expiresAt: null };
  }

  if (waitingInvites(db, office.id).length >= MAX_WAITING) {
    throw new OfficeError(409, `An office can have ${MAX_WAITING} invitations waiting. Withdraw one that is no longer needed.`);
  }
  const { token, expiresAt } = newLink();
  transaction(db, () => {
    run(
      db,
      `INSERT INTO invites
         (id, token_hash, office_id, display_name, title, role_id, room_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `inv-${randomUUID().slice(0, 8)}`,
      sha256(token),
      office.id,
      displayName,
      title,
      role.id,
      room.id,
      inviter.id,
      Date.now(),
      expiresAt,
    );
    recordAudit(db, {
      officeId: office.id,
      officeClock: now,
      actorId: inviter.id,
      actionType: "INVITE",
      subject: { taskId: null, subjectParticipantId: null, ruleId: null, roomId: room.id },
      notes: [`${inviter.displayName} invited ${displayName} as ${role.name}, with a desk in ${room.name}. They join when they accept`],
    });
  });
  return { path: `/invite/${token}`, expiresAt };
}

/** One of this office's waiting invitations, if the person may change it. */
function ownWaitingInvite(session: Session, inviteId: string): ReturnType<typeof asInviter> & { row: InviteRow } {
  const found = asInviter(session);
  const row = waitingInvites(found.db, found.office.id).find((r) => r.id === inviteId);
  if (!row) throw new OfficeError(404, "That invitation is not waiting any more.");
  const role = row.role_id ? found.office.roles[row.role_id] : undefined;
  if (role && !withinReach(found.office, found.inviter, role)) {
    throw new OfficeError(403, `You can only change an invitation into a role whose permissions you hold yourself. ${role.name} has more.`);
  }
  return { ...found, row };
}

/**
 * Replace a waiting invitation's link. The old link stops working, and the
 * seven days start again. This is how a link that was lost is recovered.
 */
export function renewInvite(session: Session, inviteId: string): { path: string; expiresAt: number } {
  const { db, office, now, inviter, row } = ownWaitingInvite(session, inviteId);
  const problem = inviteProblem(office, { ...row, expires_at: Number.MAX_SAFE_INTEGER }, Date.now());
  if (problem) throw new OfficeError(409, `${problem} Withdraw this invitation and make a new one.`);
  const { token, expiresAt } = newLink();
  transaction(db, () => {
    run(db, "UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ?", sha256(token), expiresAt, row.id);
    recordAudit(db, {
      officeId: office.id,
      officeClock: now,
      actorId: inviter.id,
      actionType: "INVITE_RENEWED",
      subject: { taskId: null, subjectParticipantId: null, ruleId: null, roomId: row.room_id },
      notes: [`${inviter.displayName} made a new link for the invitation to ${row.display_name}. The old link no longer works`],
    });
  });
  return { path: `/invite/${token}`, expiresAt };
}

/** Take a waiting invitation back. Its link stops working. */
export function withdrawInvite(session: Session, inviteId: string): { ok: true } {
  const { db, office, now, inviter, row } = ownWaitingInvite(session, inviteId);
  if (row.participant_id) {
    throw new OfficeError(
      409,
      `${row.display_name} was given a desk when they were invited, and the office's records name them. Remove them under Settings, People and agents.`,
    );
  }
  transaction(db, () => {
    run(db, "DELETE FROM invites WHERE id = ?", row.id);
    recordAudit(db, {
      officeId: office.id,
      officeClock: now,
      actorId: inviter.id,
      actionType: "INVITE_WITHDRAWN",
      subject: { taskId: null, subjectParticipantId: null, ruleId: null, roomId: row.room_id },
      notes: [`${inviter.displayName} withdrew the invitation to ${row.display_name}`],
    });
  });
  return { ok: true };
}

export interface InviteDetails {
  officeName: string;
  displayName: string;
  title: string;
  roleName: string;
  roomName: string;
}

/** The waiting invitation behind a link, with its office, or null when the link is no good. */
function liveInvite(token: string): { row: InviteRow; office: Office; now: number } | null {
  const db = officeDatabase();
  const row = get<InviteRow>(db, "SELECT * FROM invites WHERE token_hash = ?", sha256(token));
  // A link into the demo office is never good: nobody signs in there with a password.
  if (!row || isDemoOffice(row.office_id) || row.accepted_at !== null || row.expires_at <= Date.now()) return null;
  const state = loadEngineState(db, row.office_id);
  return state ? { row, office: state.office, now: state.now } : null;
}

/** What to show on the invite page, or null when the link is no longer good. */
export function readInvite(token: string): InviteDetails | null {
  const live = liveInvite(token);
  if (!live || inviteProblem(live.office, live.row, Date.now())) return null;
  const { row, office } = live;
  return {
    displayName: row.display_name,
    title: row.title,
    officeName: office.name,
    roleName: office.roles[row.role_id ?? ""]?.name ?? "",
    roomName: office.floorplan.rooms.find((r) => r.id === row.room_id)?.name ?? "the office",
  };
}

/**
 * Use an invite. A new email creates an account with the chosen password. An
 * email that already has an account joins the office with that account, and
 * must give its existing password to prove it. Either way this is the moment
 * the person is added to the office, at a desk in the room they were invited
 * to.
 */
export function acceptInvite(token: string, email: string, password: string): Promise<{ token: string }> {
  // Adding a person changes the office, so it takes its turn with everything else that does.
  return inTurn(async () => {
    const db = officeDatabase();
    const live = liveInvite(token);
    if (!live) throw new OfficeError(404, "This invite link has expired or was already used.");
    const { row, office, now } = live;

    const address = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 200) {
      throw new OfficeError(400, "Enter a valid email address.");
    }
    if (row.participant_id && userByParticipant(db, row.participant_id)) {
      throw new OfficeError(409, "This invite was already used.");
    }
    const gone = inviteProblem(office, row, Date.now());
    if (gone) throw new OfficeError(409, `${gone} Ask whoever invited you for a new invitation.`);
    const role = office.roles[row.role_id!];
    const room = office.floorplan.rooms.find((r) => r.id === row.room_id)!;

    const existing = userByEmail(db, address);
    let user: User | undefined;
    if (existing) {
      const proven = authenticate(db, address, password);
      if (!proven) {
        throw new OfficeError(401, "That email already has an account. Enter its password to join with it.");
      }
      if (seatsOf(db, proven.id).some((seat) => seat.officeId === row.office_id)) {
        throw new OfficeError(409, "That account already has a seat in this office.");
      }
      user = proven;
    } else {
      const problem = passwordProblem(password);
      if (problem) throw new OfficeError(400, problem);
    }

    // An invitation made before invitations waited by themselves may already
    // have its person in the office. They keep the desk they were given.
    const seat = row.participant_id ? null : seatFor(office, room, role, row.display_name, row.title);
    const participantId = row.participant_id ?? seat!.participant.id;
    const inviter = office.participants.find((p) => p.id === row.created_by)?.displayName ?? "someone";

    const joined = transaction(db, () => {
      if (seat) {
        writeDesk(db, seat.desk);
        writeParticipant(db, office.id, seat.participant);
      }
      const account = user ?? createUser(db, { email: address, displayName: row.display_name, password });
      addMembership(db, account.id, participantId);
      run(db, "UPDATE invites SET participant_id = ?, accepted_at = ? WHERE id = ?", participantId, Date.now(), row.id);
      recordAudit(db, {
        officeId: office.id,
        officeClock: now,
        actorId: participantId,
        actionType: "INVITE_ACCEPTED",
        subject: { taskId: null, subjectParticipantId: participantId, ruleId: null, roomId: room.id },
        notes: [`${row.display_name} accepted the invitation from ${inviter} and joined as ${role.name}, with a desk in ${room.name}`],
      });
      return account;
    });
    return issueSession(db, joined, participantId);
  });
}
