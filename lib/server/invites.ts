/**
 * Inviting a person into the office.
 *
 * A supervisor names the person, their title, a role and a room. That creates
 * a human participant with a desk in that room, and a single-use link. The
 * invited person opens the link and chooses their own email and password, so
 * nobody else ever handles their credentials. Only a hash of the link's token
 * is stored.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { freeDeskSpot } from "../geometry";
import type { Desk, Participant } from "../model";
import { supervises } from "../policy";
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
import { get, run, transaction } from "./db";
import { OfficeError, officeDatabase, recordAudit } from "./officeService";
import { loadEngineState, writeDesk, writeParticipant } from "./officeStore";

const INVITE_DAYS = 7;
const COLOURS = ["#5b8a72", "#4f7fa8", "#a8744f", "#7d6aa8", "#a85f7a", "#6a8f3f", "#3f8f8a"];

export interface InviteRequest {
  displayName: string;
  title: string;
  roleId: string;
  roomId: string;
}

export function createInvite(session: Session, request: InviteRequest): { path: string; expiresAt: number } {
  const db = officeDatabase();
  const state = session.officeId ? loadEngineState(db, session.officeId) : null;
  const inviter = state?.office.participants.find((p) => p.id === session.participantId);
  if (!state || !inviter) throw new OfficeError(404, "You are not in an office.");
  if (!supervises(state.office, inviter)) {
    throw new OfficeError(403, "Only a supervising role can invite people.");
  }

  const displayName = request.displayName.trim();
  const title = request.title.trim();
  if (displayName.length < 2 || displayName.length > 60) throw new OfficeError(400, "Enter the person's name.");
  if (title.length < 2 || title.length > 60) throw new OfficeError(400, "Enter the person's job title.");
  const role = state.office.roles[request.roleId];
  if (!role) throw new OfficeError(400, "Choose a role.");
  const room = state.office.floorplan.rooms.find((r) => r.id === request.roomId);
  if (!room) throw new OfficeError(400, "Choose a room.");
  const spot = freeDeskSpot(state.office.floorplan, room.id);
  if (!spot) throw new OfficeError(409, `${room.name} has no space for another desk.`);

  const suffix = randomUUID().slice(0, 8);
  const desk: Desk = {
    id: `desk-${suffix}`,
    roomId: room.id,
    position: spot,
    facing: 0,
    occupantId: `p-${suffix}`,
  };
  const participant: Participant = {
    id: `p-${suffix}`,
    kind: "human",
    displayName,
    title,
    roleId: role.id,
    deskId: desk.id,
    capabilities: [],
    backing: null,
    appearance: { color: COLOURS[state.office.participants.length % COLOURS.length] },
  };

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + INVITE_DAYS * 86_400_000;
  transaction(db, () => {
    writeDesk(db, desk);
    writeParticipant(db, state.office.id, participant);
    run(
      db,
      `INSERT INTO invites (id, token_hash, participant_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      `inv-${suffix}`,
      sha256(token),
      participant.id,
      inviter.id,
      now,
      expiresAt,
    );
    recordAudit(db, {
      officeId: state.office.id,
      officeClock: state.now,
      actorId: inviter.id,
      actionType: "INVITE",
      subject: { taskId: null, subjectParticipantId: participant.id, ruleId: null, roomId: room.id },
      notes: [`${inviter.displayName} invited ${displayName} as ${role.name}, with a desk in ${room.name}`],
    });
  });
  return { path: `/invite/${token}`, expiresAt };
}

export interface InviteDetails {
  officeName: string;
  displayName: string;
  title: string;
  roleName: string;
  roomName: string;
}

interface InviteRow {
  id: string;
  participant_id: string;
  office_id: string;
  expires_at: number;
  accepted_at: number | null;
}

function liveInvite(token: string): InviteRow | null {
  const row = get<InviteRow>(
    officeDatabase(),
    `SELECT i.id, i.participant_id, p.office_id, i.expires_at, i.accepted_at
       FROM invites i JOIN participants p ON p.id = i.participant_id
      WHERE i.token_hash = ?`,
    sha256(token),
  );
  return row && row.accepted_at === null && row.expires_at > Date.now() ? row : null;
}

/** What to show on the invite page, or null when the link is no longer good. */
export function readInvite(token: string): InviteDetails | null {
  const row = liveInvite(token);
  const office = row ? loadEngineState(officeDatabase(), row.office_id)?.office : null;
  const person = office?.participants.find((p) => p.id === row?.participant_id);
  if (!row || !office || !person) return null;
  const desk = office.floorplan.desks.find((d) => d.id === person.deskId);
  return {
    displayName: person.displayName,
    title: person.title,
    officeName: office.name,
    roleName: office.roles[person.roleId]?.name ?? person.roleId,
    roomName: office.floorplan.rooms.find((r) => r.id === desk?.roomId)?.name ?? "the office",
  };
}

/**
 * Use an invite. A new email creates an account with the chosen password. An
 * email that already has an account joins the office with that account, and
 * must give its existing password to prove it.
 */
export async function acceptInvite(
  token: string,
  email: string,
  password: string,
): Promise<{ token: string }> {
  const db = officeDatabase();
  const row = liveInvite(token);
  if (!row) throw new OfficeError(404, "This invite link has expired or was already used.");

  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 200) {
    throw new OfficeError(400, "Enter a valid email address.");
  }
  if (userByParticipant(db, row.participant_id)) throw new OfficeError(409, "This invite was already used.");

  const person = get<{ display_name: string }>(
    db,
    "SELECT display_name FROM participants WHERE id = ?",
    row.participant_id,
  );
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

  const joined = transaction(db, () => {
    const account =
      user ?? createUser(db, { email: address, displayName: person?.display_name ?? address, password });
    addMembership(db, account.id, row.participant_id);
    run(db, "UPDATE invites SET accepted_at = ? WHERE id = ?", Date.now(), row.id);
    return account;
  });
  return issueSession(db, joined, row.participant_id);
}
