/**
 * AI Virtual Office core data model
 *
 * Design principles
 *  1. Humans and agents are the same kind of thing: a participant with a seat
 *     and a role. The uniformity is the product statement.
 *  2. The office is data. Rooms, desks, doors and occupants all load from JSON;
 *     the 3D scene is a renderer over this model, never a source of truth.
 *  3. Access control governs movement AND information. If you cannot enter a
 *     room, you cannot read what was said in it.
 *  4. Nothing changes silently. Every individual rule records who granted it
 *     and why; every access decision reports what it overrode.
 *  5. Agents declare what they assumed. Always.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

import type { ConnectedSystem, SystemAction } from "./systems";

export type ParticipantId = string;
export type RoleId = string;
export type RoomId = string;
export type DeskId = string;
export type TaskId = string;
export type MessageId = string;
export type RuleId = string;

/** Rooms-wildcard, used in grants that apply office-wide. */
export const ANY_ROOM = "*" as const;
export type RoomSelector = RoomId | typeof ANY_ROOM;

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export type ParticipantKind = "human" | "agent";

/**
 * How an agent decides what to do. An AI agent asks a language model. A
 * playbook agent follows an ordered list of when-then steps written by a
 * person, and involves no model at all.
 */
export type AgentType = "ai" | "playbook";

export const PLAYBOOK_STAGES = ["intake", "planning", "execution", "review"] as const;

/**
 * One step of a playbook. The agent takes the first step whose conditions all
 * hold for the work in front of it, and does what that step says.
 */
export interface PlaybookStep {
  id: string;
  when: {
    /** The stage of the workflow the work is in, or "any". */
    stage: (typeof PLAYBOOK_STAGES)[number] | "any";
    /** Text the request must contain, ignoring case. Empty matches anything. */
    requestContains: string;
    /** Who filed the request, or "anyone". */
    requestedBy: ParticipantId | "anyone";
  };
  then: {
    /** One sentence logged to the thread. */
    statusNote: string;
    /** Something produced for colleagues to use. */
    output: { label: string; body: string } | null;
    /** A question, addressed to a named person or to whoever filed the request. */
    question: {
      body: string;
      to: ParticipantId | "requester";
      blocking: boolean;
      options: string[];
    } | null;
    /** A guess the agent records so that people can confirm or correct it. */
    assumption: { assumed: string; because: string; confidence: "low" | "medium" | "high" } | null;
    /** Access the step cannot proceed without. Halts the task if denied. */
    need: { room: RoomId; scope: AccessScope; purpose: string } | null;
    /** Something to do in a connected system. Needs `act` on that system's room. */
    action: SystemAction | null;
    /** Something to tell one person or agent, or whoever filed the request. */
    note: { to: ParticipantId | "requester"; body: string } | null;
  };
}

export interface Participant {
  id: ParticipantId;
  kind: ParticipantKind;
  displayName: string;
  /** Job title shown in the office, e.g. "Inventory Analyst". */
  title: string;
  roleId: RoleId;
  /** Null when the participant is not seated (a visiting human, say). */
  deskId: DeskId | null;
  /**
   * What an agent can actually do. Shown verbatim in the inspector so a
   * supervisor can see the limits of the thing sitting at that desk.
   */
  capabilities: string[];
  /**
   * Agents only: the provider and model answering for it right now. Null for
   * people, for playbook agents, and for an AI agent with no working provider.
   */
  backing: { provider: string; model: string } | null;
  /** Null for people. */
  agentType: AgentType | null;
  /** AI agents: which of the office's AI providers to use. */
  providerId: string | null;
  /** AI agents: a model id that overrides the provider's default, or null. */
  model: string | null;
  /** Playbook agents: their steps, in order. Empty for everyone else. */
  playbook: PlaybookStep[];
  appearance: { color: string };
  /**
   * Set when a person has left the office. They stay in the record, so their
   * requests, answers and decisions still carry a name, but they hold no desk,
   * no access and no sign-in, and nothing new is addressed to them.
   */
  leftAt?: number;
}

/** True for someone who is in the office now, false for a person who has left it. */
export const inOffice = (p: Participant): boolean => p.leftAt === undefined;

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

export type Wall = "north" | "south" | "east" | "west";

export interface Point2 {
  x: number;
  z: number;
}

/** Axis-aligned floor-plan rectangle, in metres. Walls are extruded from it. */
export interface Bounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Door {
  id: string;
  /** The adjoining room, or null for an exterior door. */
  toRoomId: RoomId | null;
  wall: Wall;
  /** Offset along that wall, 0..1. */
  along: number;
  width: number;
}

export interface Room {
  id: RoomId;
  name: string;
  /** Shown in the UI: what work happens here. */
  purpose: string;
  bounds: Bounds;
  doors: Door[];
  deskIds: DeskId[];
  /**
   * Facts kept in this room, one sentence each. They are shown only to
   * someone who holds `read` on the room.
   */
  records: string[];
  /** True for a room people only walk through, which other rooms open onto. */
  corridor?: boolean;
}

export interface Desk {
  id: DeskId;
  roomId: RoomId;
  position: Point2;
  /** Facing direction in radians. */
  facing: number;
  occupantId: ParticipantId | null;
}

export interface Floorplan {
  id: string;
  name: string;
  description: string;
  rooms: Room[];
  desks: Desk[];
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export type Effect = "allow" | "deny";

/**
 * enter: may be present in the room
 * read:  may see messages addressed to the room
 * act:   may own tasks and produce outputs there
 */
export type AccessScope = "enter" | "read" | "act";

export const ALL_SCOPES: AccessScope[] = ["enter", "read", "act"];

export interface AccessGrant {
  room: RoomSelector;
  scopes: AccessScope[];
  effect: Effect;
}

/**
 * Things a role may do beyond working in rooms. Each one is granted to a role
 * on its own, so an office can have someone who approves quotes without being
 * able to change access, or the other way round.
 */
export const PERMISSIONS = [
  "manage_access",
  "reassign_work",
  "decide_reviews",
  "see_everything",
  "invite_people",
  "manage_people",
  "manage_rooms",
  "manage_roles",
  "manage_providers",
  "use_shared_providers",
  "manage_office",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_INFO: Record<Permission, { label: string; description: string }> = {
  manage_access: {
    label: "Manage access",
    description: "Grant and revoke individual access rules and permission tokens. Receives escalations.",
  },
  reassign_work: { label: "Hand work over", description: "Give a task to a different owner." },
  decide_reviews: { label: "Decide reviews", description: "Approve or reject work at the review stage, or send it back with what has to change. Reject a request at any earlier stage." },
  see_everything: {
    label: "See everything",
    description: "Read every message and the whole activity log, including messages between other people.",
  },
  invite_people: { label: "Invite people", description: "Add a person to the office with a role and a desk." },
  manage_people: {
    label: "Manage people and agents",
    description: "Add, configure and remove agents. Rename people, change roles, move desks.",
  },
  manage_rooms: {
    label: "Manage rooms",
    description:
      "Add, rename and remove rooms. Choose where each stage happens. Edit the records and connected systems of rooms they can read.",
  },
  manage_roles: { label: "Manage roles", description: "Add and remove roles and change what each role may do." },
  manage_providers: {
    label: "Manage AI providers",
    description: "Add, change and remove AI providers and their API keys.",
  },
  use_shared_providers: {
    label: "Use shared AI providers",
    description: "Give agents an AI provider that another person brought to this office from their own account.",
  },
  manage_office: { label: "Manage the office", description: "Rename the office, clear all work, or remove the office." },
};

export interface Role {
  id: RoleId;
  name: string;
  description: string;
  /** What the role may do beyond working in rooms. */
  permissions: Permission[];
  grants: AccessGrant[];
}

export const roleMay = (role: Role | undefined, permission: Permission): boolean =>
  role?.permissions.includes(permission) === true;

/**
 * A rule attached to one participant. Outranks their role.
 * `reason` and `grantedBy` are required: permissions never change silently.
 */
export interface IndividualRule {
  id: RuleId;
  participantId: ParticipantId;
  room: RoomSelector;
  scopes: AccessScope[];
  effect: Effect;
  reason: string;
  grantedBy: ParticipantId;
  grantedAt: number;
  /** Optional expiry. */
  expiresAt?: number;
  /** The "just for this one task" grant. Expires when the task closes. */
  expiresOnTaskId?: TaskId;
}

// --- resolution ------------------------------------------------------------

export type DecisionSource =
  | { kind: "individual"; ruleId: RuleId; effect: Effect }
  | { kind: "role"; roleId: RoleId; grantIndex: number; effect: Effect }
  | { kind: "default"; effect: "deny" };

/** Precedence, highest first. Index 0 wins. */
export const PRECEDENCE = [
  "individual:deny",
  "individual:allow",
  "role:deny",
  "role:allow",
  "default:deny",
] as const;

export interface AccessDecision {
  participantId: ParticipantId;
  room: RoomId;
  scope: AccessScope;
  effect: Effect;
  decidedBy: DecisionSource;
  /** Everything that lost, in precedence order. Drives the conflict warning. */
  overrode: DecisionSource[];
  /** One-line, human-readable, shown in the inspector. */
  explanation: string;
}

function tierOf(source: DecisionSource): number {
  if (source.kind === "individual") {
    return source.effect === "deny" ? 0 : 1;
  }
  if (source.kind === "role") {
    return source.effect === "deny" ? 2 : 3;
  }
  return 4;
}

function matchesRoom(selector: RoomSelector, room: RoomId): boolean {
  return selector === ANY_ROOM || selector === room;
}

export interface AccessContext {
  roles: Record<RoleId, Role>;
  rules: IndividualRule[];
  /** Used to drop expired rules; pass Date.now() in production. */
  now: number;
  /** Task ids that have closed, for expiresOnTaskId. */
  closedTaskIds: ReadonlySet<TaskId>;
  /**
   * The task the access is wanted for. A rule granted for one task counts
   * only for that task's work: with a task id here, rules made for other
   * tasks are left out, and with null (outside any task) every such rule is.
   * Left undefined, a rule made for a task counts while that task is open,
   * which is right for showing what someone holds at the moment.
   */
  forTask?: TaskId | null;
}

export function isRuleLive(rule: IndividualRule, ctx: AccessContext): boolean {
  if (rule.expiresAt !== undefined && rule.expiresAt <= ctx.now) return false;
  if (rule.expiresOnTaskId !== undefined && ctx.closedTaskIds.has(rule.expiresOnTaskId)) {
    return false;
  }
  if (rule.expiresOnTaskId !== undefined && ctx.forTask !== undefined && ctx.forTask !== rule.expiresOnTaskId) {
    return false;
  }
  return true;
}

/**
 * Resolve one (participant, room, scope) triple.
 *
 * Returns the winning decision plus every rule it beat, so the UI can show
 * "denied by role Fulfilment, overridden by individual rule #4" rather than a
 * bare yes/no.
 */
export function resolveAccess(
  participant: Participant,
  room: RoomId,
  scope: AccessScope,
  ctx: AccessContext,
): AccessDecision {
  const candidates: DecisionSource[] = [];
  // Someone who has left holds nothing: no rule and no grant counts for them.
  const present = inOffice(participant);

  for (const rule of ctx.rules) {
    if (!present || rule.participantId !== participant.id) continue;
    if (!matchesRoom(rule.room, room)) continue;
    if (!rule.scopes.includes(scope)) continue;
    if (!isRuleLive(rule, ctx)) continue;
    candidates.push({ kind: "individual", ruleId: rule.id, effect: rule.effect });
  }

  const role = present ? ctx.roles[participant.roleId] : undefined;
  if (role) {
    role.grants.forEach((grant, grantIndex) => {
      if (!matchesRoom(grant.room, room)) return;
      if (!grant.scopes.includes(scope)) return;
      candidates.push({
        kind: "role",
        roleId: role.id,
        grantIndex,
        effect: grant.effect,
      });
    });
  }

  candidates.push({ kind: "default", effect: "deny" });
  candidates.sort((a, b) => tierOf(a) - tierOf(b));

  const [winner, ...losers] = candidates;
  return {
    participantId: participant.id,
    room,
    scope,
    effect: winner.effect,
    decidedBy: winner,
    overrode: losers,
    explanation: explain(winner, losers, ctx),
  };
}

function describe(source: DecisionSource, ctx: AccessContext): string {
  if (source.kind === "individual") {
    const rule = ctx.rules.find((r) => r.id === source.ruleId);
    return `individual rule ${source.ruleId} (${source.effect}${rule ? `: ${rule.reason}` : ""})`;
  }
  if (source.kind === "role") {
    const role = ctx.roles[source.roleId];
    return `role ${role ? role.name : source.roleId} (${source.effect})`;
  }
  return "default deny";
}

function explain(
  winner: DecisionSource,
  losers: DecisionSource[],
  ctx: AccessContext,
): string {
  const head = `${winner.effect === "allow" ? "Allowed" : "Denied"} by ${describe(winner, ctx)}`;
  const beaten = losers.filter((l) => l.kind !== "default" && l.effect !== winner.effect);
  if (beaten.length === 0) return head;
  return `${head}; overrides ${beaten.map((l) => describe(l, ctx)).join(", ")}`;
}

/** True when a participant has competing rules for a room. Drives the banner. */
export function hasConflict(decision: AccessDecision): boolean {
  return decision.overrode.some(
    (s) => s.kind !== "default" && s.effect !== decision.effect,
  );
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

export type MessageKind =
  | "request"
  | "assignment"
  | "question"
  | "answer"
  | "assumption"
  | "status"
  | "handoff"
  | "escalation"
  | "decision"
  | "output"
  | "note";

export type Audience =
  | { to: "participant"; id: ParticipantId }
  | { to: "room"; id: RoomId }
  | { to: "everyone" };

export interface MessageBase {
  id: MessageId;
  kind: MessageKind;
  taskId: TaskId;
  fromId: ParticipantId | "system";
  audience: Audience;
  /** Where it was said. With a room audience, `read` on this room gates it. */
  roomId: RoomId;
  at: number;
  inReplyTo?: MessageId;
  body: string;
}

export interface RequestMessage extends MessageBase {
  kind: "request";
}

export interface AssignmentMessage extends MessageBase {
  kind: "assignment";
  toParticipantId: ParticipantId;
}

/** A clarification. Blocking questions halt the task until answered. */
export interface QuestionMessage extends MessageBase {
  kind: "question";
  blocking: boolean;
  /** Offer concrete choices wherever possible. */
  options?: string[];
  answeredByMessageId?: MessageId;
  /**
   * Set when the question asks for approval to act in a connected system. The
   * action is carried out only if the answer is the Approve option.
   */
  heldAction?: SystemAction;
}

export interface AnswerMessage extends MessageBase {
  kind: "answer";
  questionId: MessageId;
  chosenOption?: string;
}

/**
 * Something the agent took as true in order to proceed. An assumption never
 * blocks. It is what you record when you *can* continue but had to guess.
 */
export interface AssumptionMessage extends MessageBase {
  kind: "assumption";
  assumed: string;
  /** What was missing that forced the guess. */
  because: string;
  confidence: "low" | "medium" | "high";
  status: "open" | "confirmed" | "contradicted";
  /** Work resting on this, invalidated if it is contradicted. */
  affectsTaskIds: TaskId[];
}

export interface StatusMessage extends MessageBase {
  kind: "status";
  progress?: number;
  /** Set on the line that reports what a connected system answered to an action. */
  did?: SystemDeed;
}

/**
 * One thing done, or refused, in a connected system on behalf of a task. The
 * office reads these to tell what a task has done that still stands.
 */
export interface SystemDeed {
  systemId: string;
  operation: string;
  ok: boolean;
  /** The number of the record the system made, changed or took back. */
  record?: string;
}

export interface HandoffMessage extends MessageBase {
  kind: "handoff";
  fromParticipantId: ParticipantId;
  toParticipantId: ParticipantId;
  toRoomId: RoomId;
}

/** Needs a human. Carries the failed decision when the cause is permission. */
export interface EscalationMessage extends MessageBase {
  kind: "escalation";
  cause: "permission" | "ambiguity" | "policy" | "error";
  deniedDecision?: AccessDecision;
}

export interface DecisionMessage extends MessageBase {
  kind: "decision";
  verdict: "approved" | "rejected" | "changes_requested";
}

export interface OutputMessage extends MessageBase {
  kind: "output";
  label: string;
  /** Marked so the UI never passes simulated output off as real. */
  simulated: boolean;
}

/**
 * Something one participant wants another to know about a task, beyond what
 * the handoff and the outputs say. It is addressed to one person or agent,
 * blocks nothing and asks for nothing.
 */
export interface NoteMessage extends MessageBase {
  kind: "note";
}

export type Message =
  | RequestMessage
  | AssignmentMessage
  | QuestionMessage
  | AnswerMessage
  | AssumptionMessage
  | StatusMessage
  | HandoffMessage
  | EscalationMessage
  | DecisionMessage
  | OutputMessage
  | NoteMessage;

/** Message visibility follows the `read` scope on the room it was said in. */
export function canRead(
  message: Message,
  viewer: Participant,
  ctx: AccessContext,
): boolean {
  if (message.audience.to === "everyone") return true;
  if (message.audience.to === "participant") {
    if (message.audience.id === viewer.id || message.fromId === viewer.id) return true;
    // A question on a task and its answer settle something about the work,
    // so whoever may read the room they were said in can read them too. The
    // stages that follow would otherwise ask the same thing again. A note
    // stays between the two it passed between.
    if (message.kind !== "question" && message.kind !== "answer") return false;
    return resolveAccess(viewer, message.roomId, "read", { ...ctx, forTask: message.taskId }).effect === "allow";
  }
  // A grant made for one task opens that task's messages in the room, not
  // every task's.
  return resolveAccess(viewer, message.audience.id, "read", { ...ctx, forTask: message.taskId }).effect === "allow";
}

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

export type WorkflowStage =
  | "intake"
  | "planning"
  | "execution"
  | "review"
  | "done";

/**
 * Two blocked states, deliberately. A task stops either because the owner
 * lacks permission or because it lacks information. Those are different
 * problems with different fixes, and the UI shows them differently.
 */
export type TaskStatus =
  | "requested"
  | "in_progress"
  | "blocked_permission"
  | "blocked_question"
  | "in_review"
  | "completed"
  | "rejected";

export interface TaskEvent {
  at: number;
  summary: string;
  messageId?: MessageId;
  /** Recorded whenever a permission check gated the transition. */
  decision?: AccessDecision;
}

/**
 * A text document that came with a request or was added to it later: a
 * dealer's email, a list of serial numbers, a page of terms. It goes wherever
 * the request goes, so every agent that works the task is shown it.
 */
export interface TaskDocument {
  id: string;
  name: string;
  body: string;
  addedById: ParticipantId;
  at: number;
}

/** How many documents a task can carry, and how long each may be. */
export const DOCUMENT_LIMITS = { perTask: 5, characters: 20_000, name: 80 } as const;

export interface Task {
  id: TaskId;
  title: string;
  detail: string;
  requestedById: ParticipantId;
  ownerId: ParticipantId | null;
  /** Where the task currently sits. Movement between rooms is the handoff. */
  roomId: RoomId;
  stage: WorkflowStage;
  status: TaskStatus;
  openQuestionIds: MessageId[];
  assumptionIds: MessageId[];
  history: TaskEvent[];
  createdAt: number;
  closedAt: number | null;
  /**
   * Set while the task's next move has a date: stock due in, a visit booked,
   * a payment expected. The task stays with its owner and is not handed on
   * until that time, when the owner is woken to carry on.
   */
  wait?: { until: number; reason: string };
  /**
   * Set while the task's owner has been given the task, or the answer of a
   * system, and has not yet taken the step that follows. The task is not
   * handed on while a step is owed.
   */
  owed?: boolean;
  /** Set by a person. An urgent task is taken ahead of the others on every agent's queue. */
  urgent?: boolean;
  /** Documents attached to the request, in the order they were added. */
  documents?: TaskDocument[];
  /**
   * Set from the moment a task is rejected until it closes, when the task
   * had already done things in connected systems. Until then a person says
   * what is to happen to them and the agents that did them carry it out.
   */
  windUp?: boolean;
}

// ---------------------------------------------------------------------------
// Office
// ---------------------------------------------------------------------------

/** Which room hosts each working stage. The final stage has no room. */
export type StageRooms = Record<Exclude<WorkflowStage, "done">, RoomId>;

export interface Office {
  id: string;
  name: string;
  floorplan: Floorplan;
  stageRooms: StageRooms;
  participants: Participant[];
  roles: Record<RoleId, Role>;
  rules: IndividualRule[];
  tasks: Task[];
  messages: Message[];
  /** Outside systems connected to rooms. Addresses and keys stay on the server. */
  systems: ConnectedSystem[];
  /**
   * When set, an agent that finishes its step cleanly hands the task to the
   * next stage by itself. Halts and the review decision still wait for a person.
   */
  autoHandoff: boolean;
}

/** Can this participant take ownership of work in this room? */
export function canOwnWorkIn(
  participant: Participant,
  room: RoomId,
  ctx: AccessContext,
): AccessDecision {
  const enter = resolveAccess(participant, room, "enter", ctx);
  if (enter.effect === "deny") return enter;
  return resolveAccess(participant, room, "act", ctx);
}

/** May this participant do this, by the permissions of their role? */
export const may = (office: Office, participant: Participant, permission: Permission): boolean =>
  inOffice(participant) && roleMay(office.roles[participant.roleId], permission);
