/**
 * Who may do what. Pure functions over the office model, shared by the server
 * (which enforces them) and the interface (which uses them to grey out what
 * the signed-in person cannot do).
 *
 * The rules come from the access model itself. Changing access, reassigning
 * work and deciding reviews each need their own permission on the role, as do
 * the set-up changes. Everything else
 * needs the `act` scope on the room where the work is.
 */
import {
  canOwnWorkIn,
  canRead,
  DOCUMENT_LIMITS,
  may,
  resolveAccess,
  type AccessContext,
  type AccessScope,
  type Message,
  type Office,
  type Participant,
  type TaskId,
} from "./model";
import { roomForStage, type Action } from "./engine";

export type Verdict = { allowed: true } | { allowed: false; reason: string };

const yes: Verdict = { allowed: true };
const no = (reason: string): Verdict => ({ allowed: false, reason });

export function contextOf(office: Office, now: number): AccessContext {
  return {
    roles: office.roles,
    rules: office.rules,
    now,
    closedTaskIds: new Set(office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id)),
  };
}

/** True when the participant's role carries any permission beyond room access. */
export const hasAnyPermission = (office: Office, p: Participant): boolean =>
  (office.roles[p.roleId]?.permissions.length ?? 0) > 0;

function mayActIn(office: Office, ctx: AccessContext, actor: Participant, roomId: string): Verdict {
  const decision = canOwnWorkIn(actor, roomId, ctx);
  if (decision.effect === "allow") return yes;
  const room = office.floorplan.rooms.find((r) => r.id === roomId)?.name ?? roomId;
  return no(`You cannot act in ${room}. ${decision.explanation}.`);
}

/** May `actor` perform `action` on this office right now? */
export function authorize(
  office: Office,
  ctx: AccessContext,
  actor: Participant,
  action: Action,
): Verdict {
  if (actor.kind !== "human") return no("Only people can take these actions.");

  switch (action.type) {
    case "SUBMIT_REQUEST":
      return mayActIn(office, ctx, actor, roomForStage(office, "intake")!);

    case "ADVANCE":
    case "WAKE_TASK": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      return task ? mayActIn(office, ctx, actor, task.roomId) : no("No such task.");
    }

    // A document can be added by whoever asked for the work, or by anyone who
    // could move it on.
    case "ADD_DOCUMENT": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      if (!task) return no("No such task.");
      if (task.closedAt !== null) return no("That task is closed.");
      if ((task.documents ?? []).length >= DOCUMENT_LIMITS.perTask) {
        return no(`A task can carry ${DOCUMENT_LIMITS.perTask} documents, and this one already does.`);
      }
      return task.requestedById === actor.id ? yes : mayActIn(office, ctx, actor, task.roomId);
    }

    // Whoever asked for the work may say it is urgent. So may anyone who
    // could move it on, or who hands work between people.
    case "SET_URGENT": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      if (!task) return no("No such task.");
      if (task.requestedById === actor.id || may(office, actor, "reassign_work")) return yes;
      return mayActIn(office, ctx, actor, task.roomId);
    }

    case "ANSWER_QUESTION": {
      const question = office.messages.find((m) => m.id === action.questionId);
      if (!question) return no("You cannot see that question.");
      if (question.audience.to === "participant" && question.audience.id === actor.id) return yes;
      // Approving an action in a connected system is for the person asked and
      // for people who manage access, not for anyone working in the room.
      if (question.kind === "question" && question.heldAction) {
        return may(office, actor, "manage_access")
          ? yes
          : no("Only the person asked, or someone who manages access, can approve that.");
      }
      return mayActIn(office, ctx, actor, question.roomId);
    }

    // Raised by the office itself when an agent has something to pick up.
    case "AGENT_RESUME":
    case "AGENT_ATTEND":
      return no("Only the office can wake an agent.");
    case "WIND_UP":
      return no("Only the office winds a rejected task up.");

    case "RESOLVE_ASSUMPTION": {
      const assumption = office.messages.find((m) => m.id === action.assumptionId);
      return assumption
        ? mayActIn(office, ctx, actor, assumption.roomId)
        : no("You cannot see that assumption.");
    }

    case "GRANT_ACCESS":
    case "REVOKE_RULE":
      return may(office, actor, "manage_access")
        ? yes
        : no("Your role does not include managing access rules.");
    case "REASSIGN":
      return may(office, actor, "reassign_work") ? yes : no("Your role does not include handing work over.");
    case "DECIDE":
      return may(office, actor, "decide_reviews") ? yes : no("Your role does not include deciding reviews.");
  }
}

/**
 * Overwrite every "who did this" field with the signed-in participant. The
 * server never trusts an actor id sent by the browser.
 */
export function stampActor(action: Action, actorId: string): Action {
  switch (action.type) {
    case "SUBMIT_REQUEST":
      return { ...action, requestedById: actorId };
    case "ANSWER_QUESTION":
      return { ...action, answeredById: actorId };
    case "GRANT_ACCESS":
      return { ...action, grantedBy: actorId };
    case "REVOKE_RULE":
      return { ...action, revokedBy: actorId };
    case "REASSIGN":
    case "RESOLVE_ASSUMPTION":
    case "DECIDE":
    case "WAKE_TASK":
    case "SET_URGENT":
    case "ADD_DOCUMENT":
      return { ...action, byId: actorId };
    case "ADVANCE":
    case "AGENT_RESUME":
    case "AGENT_ATTEND":
    case "WIND_UP":
      return action;
  }
}

const SCOPES: AccessScope[] = ["enter", "read", "act"];

/**
 * Documents as they arrive from a browser: a few named pieces of plain text.
 * Returns null when any of them is not that, so the whole request is refused
 * and nothing is quietly dropped.
 */
function documents(value: unknown): { name: string; body: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DOCUMENT_LIMITS.perTask) return null;
  const read: { name: string; body: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { name, body } = item as Record<string, unknown>;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > DOCUMENT_LIMITS.name) return null;
    if (typeof body !== "string" || body.trim().length === 0 || body.length > DOCUMENT_LIMITS.characters) return null;
    // A file that is not text shows itself by the characters text never holds.
    if (/[\u0000-\u0008\u000e-\u001f]/.test(body)) return null;
    read.push({ name: name.trim(), body });
  }
  return read;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Turn untrusted JSON into an Action, or null when it is not one. Only known
 * fields are copied, so nothing unexpected reaches the engine.
 */
export function parseAction(input: unknown): Action | null {
  if (!input || typeof input !== "object") return null;
  const a = input as Record<string, unknown>;
  switch (a.type) {
    case "SUBMIT_REQUEST":
      return text(a.title, 120) && text(a.detail, 2000) && (a.documents === undefined || documents(a.documents) !== null)
        ? {
            type: "SUBMIT_REQUEST",
            title: a.title.trim(),
            detail: a.detail.trim(),
            requestedById: "",
            ...(a.urgent === true ? { urgent: true } : {}),
            ...((documents(a.documents) ?? []).length > 0 ? { documents: documents(a.documents)! } : {}),
          }
        : null;
    case "ADVANCE":
      return text(a.taskId, 40) ? { type: "ADVANCE", taskId: a.taskId } : null;
    case "ANSWER_QUESTION":
      return text(a.questionId, 40) && text(a.body, 600)
        ? {
            type: "ANSWER_QUESTION",
            questionId: a.questionId,
            answeredById: "",
            body: a.body.trim(),
            ...(text(a.chosenOption, 200) ? { chosenOption: a.chosenOption } : {}),
          }
        : null;
    case "GRANT_ACCESS": {
      const scopes = Array.isArray(a.scopes) ? SCOPES.filter((s) => (a.scopes as unknown[]).includes(s)) : [];
      if (!text(a.participantId, 40) || !text(a.room, 40) || !text(a.reason, 300)) return null;
      if (scopes.length === 0 || (a.effect !== "allow" && a.effect !== "deny")) return null;
      return {
        type: "GRANT_ACCESS",
        participantId: a.participantId,
        room: a.room,
        scopes,
        effect: a.effect,
        reason: a.reason.trim(),
        grantedBy: "",
        ...(text(a.expiresOnTaskId, 40) ? { expiresOnTaskId: a.expiresOnTaskId } : {}),
        ...(typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt)
          ? { expiresAt: a.expiresAt }
          : {}),
      };
    }
    case "REVOKE_RULE":
      return text(a.ruleId, 40) ? { type: "REVOKE_RULE", ruleId: a.ruleId, revokedBy: "" } : null;
    case "REASSIGN":
      return text(a.taskId, 40) && text(a.toParticipantId, 40)
        ? { type: "REASSIGN", taskId: a.taskId, toParticipantId: a.toParticipantId, byId: "" }
        : null;
    case "RESOLVE_ASSUMPTION":
      return text(a.assumptionId, 40) && (a.status === "confirmed" || a.status === "contradicted")
        ? { type: "RESOLVE_ASSUMPTION", assumptionId: a.assumptionId, status: a.status, byId: "" }
        : null;
    case "DECIDE":
      return text(a.taskId, 40) &&
        (a.verdict === "approved" || a.verdict === "rejected" || a.verdict === "changes_requested")
        ? {
            type: "DECIDE",
            taskId: a.taskId,
            byId: "",
            verdict: a.verdict,
            ...(text(a.comment, 600) ? { comment: a.comment.trim() } : {}),
          }
        : null;
    case "WAKE_TASK":
      return text(a.taskId, 40) ? { type: "WAKE_TASK", taskId: a.taskId, byId: "" } : null;
    case "ADD_DOCUMENT":
      return text(a.taskId, 40) && documents([{ name: a.name, body: a.body }]) !== null
        ? { type: "ADD_DOCUMENT", taskId: a.taskId, ...documents([{ name: a.name, body: a.body }])![0], byId: "" }
        : null;
    case "SET_URGENT":
      return text(a.taskId, 40) && typeof a.urgent === "boolean"
        ? { type: "SET_URGENT", taskId: a.taskId, urgent: a.urgent, byId: "" }
        : null;
    default:
      return null;
  }
}

/**
 * The office as one viewer is allowed to see it. Messages follow the `read`
 * scope of the room they were said in. Tasks stay listed for everyone, with a
 * count of the messages withheld from this viewer.
 */
export function viewFor(
  office: Office,
  ctx: AccessContext,
  viewer: Participant,
): { office: Office; hiddenMessages: Record<TaskId, number> } {
  // A room's records follow `read` on the room for everyone, whatever else
  // their role lets them see.
  const rooms = office.floorplan.rooms.map((room) =>
    resolveAccess(viewer, room.id, "read", { ...ctx, forTask: null }).effect === "allow" ? room : { ...room, records: [] },
  );
  const floorplan = { ...office.floorplan, rooms };
  if (may(office, viewer, "see_everything")) return { office: { ...office, floorplan }, hiddenMessages: {} };

  const hiddenMessages: Record<TaskId, number> = {};
  const messages: Message[] = [];
  for (const message of office.messages) {
    if (canRead(message, viewer, ctx)) messages.push(message);
    else hiddenMessages[message.taskId] = (hiddenMessages[message.taskId] ?? 0) + 1;
  }
  return { office: { ...office, messages, floorplan }, hiddenMessages };
}

/** May this viewer read what is said in a room? Used to filter the activity feed. */
export const mayRead = (ctx: AccessContext, viewer: Participant, roomId: string): boolean =>
  resolveAccess(viewer, roomId, "read", ctx).effect === "allow";
