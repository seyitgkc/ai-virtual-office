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
  createUser,
  issueSession,
  passwordProblem,
  sha256,
  userByParticipant,
  type Session,
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
  const state = loadEngineState(db);
  const inviter = state?.office.participants.find((p) => p.id === session.participantId);
  if (!state || !inviter) throw new OfficeError(404, "No office has been set up.");
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
  displayName: string;
  title: string;
  roleName: string;
  roomName: string;
}

interface InviteRow {
  id: string;
  participant_id: string;
  expires_at: number;
  accepted_at: number | null;
}

function liveInvite(token: string): InviteRow | null {
  const row = get<InviteRow>(
    officeDatabase(),
    "SELECT id, participant_id, expires_at, accepted_at FROM invites WHERE token_hash = ?",
    sha256(token),
  );
  return row && row.accepted_at === null && row.expires_at > Date.now() ? row : null;
}

/** What to show on the invite page, or null when the link is no longer good. */
export function readInvite(token: string): InviteDetails | null {
  const row = liveInvite(token);
  const office = loadEngineState(officeDatabase())?.office;
  const person = office?.participants.find((p) => p.id === row?.participant_id);
  if (!row || !office || !person) return null;
  const desk = office.floorplan.desks.find((d) => d.id === person.deskId);
  return {
    displayName: person.displayName,
    title: person.title,
    roleName: office.roles[person.roleId]?.name ?? person.roleId,
    roomName: office.floorplan.rooms.find((r) => r.id === desk?.roomId)?.name ?? "the office",
  };
}

/** Use an invite: create the account and sign the person in. */
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
  const problem = passwordProblem(password);
  if (problem) throw new OfficeError(400, problem);
  if (get(db, "SELECT 1 AS found FROM users WHERE email = ?", address)) {
    throw new OfficeError(409, "That email address already has an account.");
  }
  if (userByParticipant(db, row.participant_id)) {
    throw new OfficeError(409, "This invite was already used.");
  }

  const user = transaction(db, () => {
    const created = createUser(db, { participantId: row.participant_id, email: address, password });
    run(db, "UPDATE invites SET accepted_at = ? WHERE id = ?", Date.now(), row.id);
    return created;
  });
  return issueSession(db, { ...user, email: address });
}
