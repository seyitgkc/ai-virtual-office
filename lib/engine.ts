/**
 * Workflow engine. A state transition function over an Office snapshot.
 *
 * `reduce` never mutates its input and has no side effects of its own. It is
 * asynchronous only because it waits for the agent runtime.
 *
 * Two ideas carry the whole thing:
 *
 *  1. A stage transition is an ordinary handoff. The task moves to the next
 *     room and is picked up by whoever is seated there and allowed to `act`.
 *     A permission block comes from somewhere else: an agent declaring, in the
 *     middle of its step, that it `needs` a scope on another room. If the
 *     access model denies that, the task stops and an escalation goes to a
 *     human.
 *
 *  2. Agent reasoning sits behind one interface, `AgentRuntime`, which returns
 *     five primitives: a status note, questions, assumptions, access needs and
 *     output. A playbook agent answers from steps a person wrote, an AI agent
 *     from a language model, and the engine cannot tell them apart.
 */

import {
  ANY_ROOM,
  canOwnWorkIn,
  canRead,
  resolveAccess,
  roleMay,
  type AccessContext,
  type AccessScope,
  type AccessDecision,
  type AssumptionMessage,
  type Message,
  type Office,
  type Participant,
  type ParticipantId,
  type QuestionMessage,
  type RoomId,
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkflowStage,
} from "./model";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface StageSpec {
  stage: WorkflowStage;
  label: string;
  /** Review is closed by a human decision, not by advancing. */
  humanGate: boolean;
}

/** The stages in order. Which room hosts each one is set per office. */
export const PIPELINE: StageSpec[] = [
  { stage: "intake", label: "Intake", humanGate: false },
  { stage: "planning", label: "Planning", humanGate: false },
  { stage: "execution", label: "Execution", humanGate: false },
  { stage: "review", label: "Review", humanGate: true },
  { stage: "done", label: "Complete", humanGate: false },
];

/** The room that hosts a stage, or null for the final stage. */
/** A room's name for notes people read, falling back to its id. */
const roomName = (office: Office, id: RoomId): string =>
  office.floorplan.rooms.find((r) => r.id === id)?.name ?? id;

export const roomForStage = (office: Office, stage: WorkflowStage): RoomId | null =>
  stage === "done" ? null : office.stageRooms[stage];

export const stageSpec = (stage: WorkflowStage): StageSpec => {
  const found = PIPELINE.find((s) => s.stage === stage);
  if (!found) throw new Error(`Unknown stage ${stage}`);
  return found;
};

/**
 * The status of open, unblocked work at a stage. At a stage a person must
 * close, that is waiting for their decision. Anywhere else it is in progress.
 */
const openStatus = (stage: WorkflowStage): TaskStatus =>
  PIPELINE.find((s) => s.stage === stage)?.humanGate ? "in_review" : "in_progress";

export const nextStage = (stage: WorkflowStage): WorkflowStage | null => {
  const i = PIPELINE.findIndex((s) => s.stage === stage);
  return i >= 0 && i < PIPELINE.length - 1 ? PIPELINE[i + 1].stage : null;
};

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/** What an agent knows about the office around it when it takes a step. */
export interface AgentSurroundings {
  /** The name of the office the agent works in. */
  officeName: string;
  /** Every room, and whether this agent may read what is said and kept there. */
  rooms: { id: RoomId; name: string; purpose: string; readable: boolean }[];
  /** People the agent can address a question to. */
  people: { id: ParticipantId; displayName: string; title: string }[];
}

export interface AgentStepInput {
  task: Task;
  stage: WorkflowStage;
  participant: Participant;
  /**
   * What has been said about this task, oldest first, limited to the
   * messages this agent is allowed to read. An agent never receives a
   * message from a room it cannot read.
   */
  priorMessages: Message[];
  surroundings: AgentSurroundings;
}

export interface DraftQuestion {
  body: string;
  toParticipantId: ParticipantId;
  blocking: boolean;
  options?: string[];
}

export interface DraftAssumption {
  assumed: string;
  because: string;
  confidence: "low" | "medium" | "high";
  body?: string;
}

/**
 * A room an agent must reach into to finish its current step. This is where
 * permission blocks actually come from: not from moving between stages, which
 * is an ordinary handoff, but from an agent needing data held somewhere it is
 * not allowed to look.
 */
export interface AccessNeed {
  room: RoomId;
  scope: AccessScope;
  /** Shown to the human in the escalation: why this access is needed. */
  purpose: string;
}

export interface AgentStepResult {
  statusNote?: string;
  questions: DraftQuestion[];
  /** Agents declare every guess they had to make. Non-negotiable. */
  assumptions: DraftAssumption[];
  needs?: AccessNeed[];
  output?: { label: string; body: string };
}

/**
 * `step` is asynchronous because an AI agent takes time to answer. A playbook
 * agent resolves at once; an AI agent resolves when its model replies.
 */
export interface AgentRuntime {
  step(input: AgentStepInput): Promise<AgentStepResult>;
}

// ---------------------------------------------------------------------------
// Engine state & actions
// ---------------------------------------------------------------------------

export interface EngineState {
  office: Office;
  now: number;
  seq: number;
  /** Minutes the clock advances per action, so timestamps read sensibly. */
  clockStepMinutes: number;
  /**
   * A short tag placed in every id this office generates, so that ids from
   * different offices in one database never collide. Empty for a lone office.
   */
  idScope?: string;
}

export type Action =
  | { type: "SUBMIT_REQUEST"; title: string; detail: string; requestedById: ParticipantId }
  | { type: "ADVANCE"; taskId: TaskId }
  | {
      type: "ANSWER_QUESTION";
      questionId: string;
      answeredById: ParticipantId;
      body: string;
      chosenOption?: string;
    }
  | {
      type: "GRANT_ACCESS";
      participantId: ParticipantId;
      room: RoomId;
      scopes: ("enter" | "read" | "act")[];
      effect: "allow" | "deny";
      reason: string;
      grantedBy: ParticipantId;
      expiresOnTaskId?: TaskId;
      expiresAt?: number;
    }
  | { type: "REVOKE_RULE"; ruleId: string; revokedBy: ParticipantId }
  | { type: "REASSIGN"; taskId: TaskId; toParticipantId: ParticipantId; byId: ParticipantId }
  | {
      type: "RESOLVE_ASSUMPTION";
      assumptionId: string;
      status: "confirmed" | "contradicted";
      byId: ParticipantId;
    }
  | {
      type: "DECIDE";
      taskId: TaskId;
      byId: ParticipantId;
      verdict: "approved" | "rejected" | "changes_requested";
    };

export interface StepResult {
  state: EngineState;
  /** Messages produced by this action, in order. */
  emitted: Message[];
  /** Plain-language trace for the activity feed and for debugging. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextOf(state: EngineState): AccessContext {
  return {
    roles: state.office.roles,
    rules: state.office.rules,
    now: state.now,
    closedTaskIds: new Set(
      state.office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id),
    ),
  };
}

const findParticipant = (o: Office, id: ParticipantId): Participant => {
  const p = o.participants.find((x) => x.id === id);
  if (!p) throw new Error(`No participant ${id}`);
  return p;
};

const findTask = (o: Office, id: TaskId): Task => {
  const t = o.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No task ${id}`);
  return t;
};

/** The room a participant is seated in, or null if unseated. */
export function roomOf(office: Office, p: Participant): RoomId | null {
  if (!p.deskId) return null;
  const desk = office.floorplan.desks.find((d) => d.id === p.deskId);
  return desk ? desk.roomId : null;
}

/** Everyone who could legitimately own work in this room. Drives the "Hand to" buttons. */
export function eligibleOwners(
  office: Office,
  room: RoomId,
  ctx: AccessContext,
): Participant[] {
  return office.participants.filter(
    (p) => canOwnWorkIn(p, room, ctx).effect === "allow",
  );
}

function replaceTask(office: Office, updated: Task): Office {
  return { ...office, tasks: office.tasks.map((t) => (t.id === updated.id ? updated : t)) };
}

function replaceMessage(office: Office, updated: Message): Office {
  return {
    ...office,
    messages: office.messages.map((m) => (m.id === updated.id ? updated : m)),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export async function reduce(
  state: EngineState,
  action: Action,
  runtime: AgentRuntime,
): Promise<StepResult> {
  const now = state.now + state.clockStepMinutes * 60_000;
  let seq = state.seq;
  const nextId = (prefix: string): string => `${prefix}-${state.idScope ?? ""}${++seq}`;
  const emitted: Message[] = [];
  const notes: string[] = [];
  let office = state.office;

  const done = (): StepResult => ({
    state: { ...state, office, now, seq },
    emitted,
    notes,
  });

  switch (action.type) {
    // -- a human files new work ------------------------------------------
    case "SUBMIT_REQUEST": {
      const room = roomForStage(office, "intake")!;
      const ctx = contextOf({ ...state, office, now });
      const candidates = eligibleOwners(office, room, ctx).filter(
        (p) => p.kind === "agent",
      );
      const owner = candidates[0] ?? null;

      const task: Task = {
        id: nextId("T"),
        title: action.title,
        detail: action.detail,
        requestedById: action.requestedById,
        ownerId: owner ? owner.id : null,
        roomId: room,
        stage: "intake",
        status: owner ? "in_progress" : "requested",
        openQuestionIds: [],
        assumptionIds: [],
        history: [{ at: now, summary: `Request received in ${room}` }],
        createdAt: now,
        closedAt: null,
      };

      const request: Message = {
        id: nextId("m"),
        kind: "request",
        taskId: task.id,
        fromId: action.requestedById,
        audience: { to: "room", id: room },
        roomId: room,
        at: now,
        body: action.detail,
      };
      emitted.push(request);
      office = { ...office, tasks: [...office.tasks, task], messages: [...office.messages, request] };
      notes.push(`${task.id} opened in ${roomName(office, room)}${owner ? `, owned by ${owner.displayName}` : " with no eligible owner"}`);

      if (owner) {
        const run = await runAgent(office, task, "intake", owner, runtime, now, nextId);
        office = run.office;
        emitted.push(...run.emitted);
        notes.push(...run.notes);
      }
      return done();
    }

    // -- move a task to the next stage ------------------------------------
    case "ADVANCE": {
      const task = findTask(office, action.taskId);

      if (task.status === "blocked_question") {
        notes.push(`${task.id} cannot advance: ${task.openQuestionIds.length} question(s) unanswered`);
        return done();
      }
      if (task.closedAt !== null) {
        notes.push(`${task.id} is already closed`);
        return done();
      }

      const current = stageSpec(task.stage);
      if (current.humanGate) {
        notes.push(`${task.id} is in ${current.label} and needs a human decision, not an advance`);
        return done();
      }

      const target = nextStage(task.stage);
      if (target === null) {
        notes.push(`${task.id} is already at the end of the pipeline`);
        return done();
      }
      const targetSpec = stageSpec(target);
      const targetRoom = roomForStage(office, target) ?? task.roomId;
      const ctx = contextOf({ ...state, office, now });

      // Moving between stages is an ordinary handoff: the work goes to whoever
      // is seated in the next room and allowed to act there. Keep the current
      // owner only when they qualify, which happens when two stages share a
      // room. A block here means nobody at all may work in that room.
      const owner = task.ownerId ? findParticipant(office, task.ownerId) : null;
      let carrier: Participant | null = null;
      let decision: AccessDecision | null = null;

      if (owner) {
        const d = canOwnWorkIn(owner, targetRoom, ctx);
        if (d.effect === "allow") {
          carrier = owner;
          decision = d;
        }
      }
      if (!carrier) {
        const seatedFirst = eligibleOwners(office, targetRoom, ctx)
          .filter((p) => p.kind === "agent")
          .sort((a, b) => {
            const aHere = roomOf(office, a) === targetRoom ? 0 : 1;
            const bHere = roomOf(office, b) === targetRoom ? 0 : 1;
            return aHere - bHere;
          });
        if (seatedFirst.length > 0) {
          carrier = seatedFirst[0];
          decision = canOwnWorkIn(carrier, targetRoom, ctx);
        }
      }

      if (!carrier) {
        const supervisor =
          office.participants.find((p) => p.kind === "human" && roleMay(office.roles[p.roleId], "manage_access")) ??
          office.participants.find((p) => p.kind === "human");
        const escalation: Message = {
          id: nextId("m"),
          kind: "escalation",
          taskId: task.id,
          fromId: owner ? owner.id : "system",
          audience: supervisor ? { to: "participant", id: supervisor.id } : { to: "everyone" },
          roomId: task.roomId,
          at: now,
          body: `${task.id} cannot move to ${targetSpec.label}: nobody may act in ${targetRoom}.`,
          cause: "permission",
        };
        emitted.push(escalation);
        office = {
          ...replaceTask(office, {
            ...task,
            status: "blocked_permission",
            history: [
              ...task.history,
              { at: now, summary: `No eligible owner in ${targetRoom}`, messageId: escalation.id },
            ],
          }),
          messages: [...office.messages, escalation],
        };
        notes.push(`${task.id} blocked: no eligible owner in ${targetRoom}`);
        return done();
      }

      const changedHands = carrier.id !== owner?.id;
      if (changedHands) {
        const handoff: Message = {
          id: nextId("m"),
          kind: "handoff",
          taskId: task.id,
          fromId: owner ? owner.id : "system",
          audience: { to: "room", id: targetRoom },
          roomId: targetRoom,
          at: now,
          body: `${task.id} handed to ${carrier.displayName} for ${targetSpec.label}.`,
          fromParticipantId: owner ? owner.id : carrier.id,
          toParticipantId: carrier.id,
          toRoomId: targetRoom,
        };
        emitted.push(handoff);
        office = { ...office, messages: [...office.messages, handoff] };
      }

      const moved: Task = {
        ...task,
        stage: target,
        roomId: targetRoom,
        ownerId: carrier.id,
        status: targetSpec.humanGate ? "in_review" : "in_progress",
        history: [
          ...task.history,
          {
            at: now,
            summary: `Moved to ${targetSpec.label} in ${targetRoom}, owned by ${carrier.displayName}`,
            ...(decision ? { decision } : {}),
          },
        ],
      };
      office = replaceTask(office, moved);
      notes.push(
        `${task.id} moved to ${targetSpec.label} (${roomName(office, targetRoom)}), owner ${carrier.displayName}`,
      );

      const run = await runAgent(office, moved, target, carrier, runtime, now, nextId);
      office = run.office;
      emitted.push(...run.emitted);
      notes.push(...run.notes);
      return done();
    }

    // -- a human answers a blocking question -------------------------------
    case "ANSWER_QUESTION": {
      const question = office.messages.find(
        (m): m is QuestionMessage => m.id === action.questionId && m.kind === "question",
      );
      if (!question) {
        notes.push(`No question ${action.questionId}`);
        return done();
      }

      const answer: Message = {
        id: nextId("m"),
        kind: "answer",
        taskId: question.taskId,
        fromId: action.answeredById,
        // A question raised by the system has no person to reply to, so its
        // answer goes to the room the question was asked in.
        audience:
          question.fromId === "system"
            ? { to: "room", id: question.roomId }
            : { to: "participant", id: question.fromId },
        roomId: question.roomId,
        at: now,
        inReplyTo: question.id,
        body: action.body,
        questionId: question.id,
        ...(action.chosenOption ? { chosenOption: action.chosenOption } : {}),
      };
      emitted.push(answer);
      office = replaceMessage(office, { ...question, answeredByMessageId: answer.id });
      office = { ...office, messages: [...office.messages, answer] };

      const task = findTask(office, question.taskId);
      const stillOpen = task.openQuestionIds.filter((id) => id !== question.id);
      const unblocked: Task = {
        ...task,
        openQuestionIds: stillOpen,
        status:
          stillOpen.length === 0 && task.status === "blocked_question"
            ? openStatus(task.stage)
            : task.status,
        history: [
          ...task.history,
          { at: now, summary: `Question answered by ${action.answeredById}`, messageId: answer.id },
        ],
      };
      office = replaceTask(office, unblocked);
      notes.push(
        `${task.id}: question answered` +
          (stillOpen.length === 0 ? ", unblocked" : `, ${stillOpen.length} still open`),
      );
      return done();
    }

    // -- a supervisor grants or denies access -------------------------------
    case "GRANT_ACCESS": {
      const rule = {
        id: nextId("r"),
        participantId: action.participantId,
        room: action.room,
        scopes: action.scopes,
        effect: action.effect,
        reason: action.reason,
        grantedBy: action.grantedBy,
        grantedAt: now,
        ...(action.expiresOnTaskId ? { expiresOnTaskId: action.expiresOnTaskId } : {}),
        ...(action.expiresAt ? { expiresAt: action.expiresAt } : {}),
      };
      office = { ...office, rules: [...office.rules, rule] };

      const who = findParticipant(office, action.participantId);
      notes.push(
        `${rule.id}: ${action.effect} ${action.scopes.join("/")} on ${
          action.room === ANY_ROOM ? "every room" : roomName(office, action.room)
        } for ${who.displayName}` +
          (action.expiresOnTaskId ? ` (expires with ${action.expiresOnTaskId})` : ""),
      );

      const retried = retryBlocked(office, { ...state, office, now }, now, rule.id, rule.participantId);
      office = retried.office;
      notes.push(...retried.notes);
      return done();
    }

    case "REVOKE_RULE": {
      const rule = office.rules.find((r) => r.id === action.ruleId);
      if (!rule) {
        notes.push(`No rule ${action.ruleId}`);
        return done();
      }
      office = { ...office, rules: office.rules.filter((r) => r.id !== action.ruleId) };
      notes.push(
        `${action.ruleId} revoked by ${findParticipant(office, action.revokedBy).displayName}`,
      );
      const afterRevoke = retryBlocked(
        office,
        { ...state, office, now },
        now,
        `revocation of ${action.ruleId}`,
        rule.participantId,
      );
      office = afterRevoke.office;
      notes.push(...afterRevoke.notes);
      return done();
    }

    // -- hand the task to someone who is allowed ---------------------------
    case "REASSIGN": {
      const task = findTask(office, action.taskId);
      const to = findParticipant(office, action.toParticipantId);
      const target = nextStage(task.stage);
      const room = target ? (roomForStage(office, target) ?? task.roomId) : task.roomId;
      const ctx = contextOf({ ...state, office, now });
      const decision = canOwnWorkIn(to, room, ctx);

      if (decision.effect === "deny") {
        notes.push(`Cannot reassign ${task.id} to ${to.displayName}: ${decision.explanation}`);
        return done();
      }

      const handoff: Message = {
        id: nextId("m"),
        kind: "handoff",
        taskId: task.id,
        fromId: action.byId,
        audience: { to: "room", id: room },
        roomId: room,
        at: now,
        body: `${to.displayName} picks up ${task.id}.`,
        fromParticipantId: task.ownerId ?? action.byId,
        toParticipantId: to.id,
        toRoomId: room,
      };
      emitted.push(handoff);
      office = {
        ...replaceTask(office, {
          ...task,
          ownerId: to.id,
          status: task.status === "blocked_permission" ? openStatus(task.stage) : task.status,
          history: [
            ...task.history,
            { at: now, summary: `Reassigned to ${to.displayName}`, messageId: handoff.id, decision },
          ],
        }),
        messages: [...office.messages, handoff],
      };
      notes.push(`${task.id} reassigned to ${to.displayName}`);
      return done();
    }

    // -- a human rules on an assumption ------------------------------------
    case "RESOLVE_ASSUMPTION": {
      const assumption = office.messages.find(
        (m): m is AssumptionMessage =>
          m.id === action.assumptionId && m.kind === "assumption",
      );
      if (!assumption) {
        notes.push(`No assumption ${action.assumptionId}`);
        return done();
      }
      office = replaceMessage(office, { ...assumption, status: action.status });
      notes.push(`${assumption.id} marked ${action.status} by ${action.byId}`);

      if (action.status === "confirmed") return done();

      // Contradicted: work resting on it must stop and be re-asked.
      for (const taskId of assumption.affectsTaskIds) {
        const task = office.tasks.find((t) => t.id === taskId);
        if (!task || task.closedAt !== null) continue;

        const question: Message = {
          id: nextId("m"),
          kind: "question",
          taskId: task.id,
          fromId: "system",
          audience: task.ownerId
            ? { to: "participant", id: task.ownerId }
            : { to: "room", id: task.roomId },
          roomId: task.roomId,
          at: now,
          inReplyTo: assumption.id,
          body: `"${assumption.assumed}" was contradicted by ${action.byId}. What is the correct value?`,
          blocking: true,
        };
        emitted.push(question);
        office = {
          ...replaceTask(office, {
            ...task,
            status: "blocked_question",
            openQuestionIds: [...task.openQuestionIds, question.id],
            history: [
              ...task.history,
              {
                at: now,
                summary: `Halted: rested on a contradicted assumption (${assumption.id})`,
                messageId: question.id,
              },
            ],
          }),
          messages: [...office.messages, question],
        };
        notes.push(`${task.id} halted because it rested on ${assumption.id}`);
      }
      return done();
    }

    // -- the review gate ----------------------------------------------------
    case "DECIDE": {
      const task = findTask(office, action.taskId);
      const by = findParticipant(office, action.byId);
      const ctx = contextOf({ ...state, office, now });
      const decision = resolveAccess(by, task.roomId, "act", ctx);

      if (decision.effect === "deny") {
        notes.push(`${by.displayName} may not decide in ${roomName(office, task.roomId)}: ${decision.explanation}`);
        return done();
      }

      const ruling: Message = {
        id: nextId("m"),
        kind: "decision",
        taskId: task.id,
        fromId: by.id,
        audience: { to: "room", id: task.roomId },
        roomId: task.roomId,
        at: now,
        body:
          action.verdict === "approved"
            ? "Approved."
            : action.verdict === "rejected"
              ? "Rejected."
              : "Changes requested.",
        verdict: action.verdict,
      };
      emitted.push(ruling);

      const closed = action.verdict === "approved" || action.verdict === "rejected";
      office = {
        ...replaceTask(office, {
          ...task,
          stage: action.verdict === "approved" ? "done" : task.stage,
          status:
            action.verdict === "approved"
              ? "completed"
              : action.verdict === "rejected"
                ? "rejected"
                : "in_progress",
          closedAt: closed ? now : null,
          history: [
            ...task.history,
            { at: now, summary: `${by.displayName}: ${action.verdict}`, messageId: ruling.id, decision },
          ],
        }),
        messages: [...office.messages, ruling],
      };
      notes.push(`${task.id} ${action.verdict} by ${by.displayName}`);
      return done();
    }
  }
}

/**
 * After any permission change, re-test every task that is blocked on one.
 * The thing to re-test is recorded on the task's most recent permission
 * escalation, so there is no guessing about what it was waiting for.
 */
function retryBlocked(
  office: Office,
  state: EngineState,
  now: number,
  cause: string,
  /** Whose access just changed. Other people's blocks are re-tested quietly. */
  changedFor: ParticipantId,
): { office: Office; notes: string[] } {
  const ctx = contextOf(state);
  const notes: string[] = [];
  let next = office;

  for (const task of office.tasks) {
    if (task.status !== "blocked_permission") continue;

    const escalation = [...office.messages]
      .reverse()
      .find(
        (m): m is Message & { deniedDecision: AccessDecision } =>
          m.taskId === task.id &&
          m.kind === "escalation" &&
          (m as { deniedDecision?: AccessDecision }).deniedDecision !== undefined,
      );
    if (!escalation) continue;

    const { participantId, room, scope } = escalation.deniedDecision;
    const who = office.participants.find((p) => p.id === participantId);
    if (!who) continue;

    const verdict = resolveAccess(who, room, scope, ctx);
    if (verdict.effect !== "allow") {
      if (participantId === changedFor) {
        notes.push(
          `${task.id} still blocked after ${cause}. ${verdict.explanation}`,
        );
      }
      continue;
    }

    next = replaceTask(next, {
      ...task,
      status: openStatus(task.stage),
      history: [
        ...task.history,
        { at: now, summary: `Unblocked by ${cause}`, decision: verdict },
      ],
    });
    notes.push(
      `${task.id} unblocked by ${cause}. ${
        openStatus(task.stage) === "in_review" ? "It is ready for a decision." : "Advance it to continue."
      }`,
    );
  }

  return { office: next, notes };
}

// ---------------------------------------------------------------------------
// Agent turn
// ---------------------------------------------------------------------------

async function runAgent(
  office: Office,
  task: Task,
  stage: WorkflowStage,
  participant: Participant,
  runtime: AgentRuntime,
  now: number,
  nextId: (prefix: string) => string,
): Promise<{ office: Office; emitted: Message[]; notes: string[] }> {
  if (participant.kind !== "agent") {
    return { office, emitted: [], notes: [] };
  }

  const ctx: AccessContext = {
    roles: office.roles,
    rules: office.rules,
    now,
    closedTaskIds: new Set(office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id)),
  };
  const prior = office.messages
    .filter((m) => m.taskId === task.id && canRead(m, participant, ctx))
    .sort((a, b) => a.at - b.at);
  const surroundings: AgentSurroundings = {
    officeName: office.name,
    rooms: office.floorplan.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      purpose: room.purpose,
      readable: resolveAccess(participant, room.id, "read", ctx).effect === "allow",
    })),
    people: office.participants
      .filter((p) => p.kind === "human")
      .map((p) => ({ id: p.id, displayName: p.displayName, title: p.title })),
  };

  const result = await runtime.step({
    task,
    stage,
    participant,
    priorMessages: prior,
    surroundings,
  });
  const emitted: Message[] = [];
  const notes: string[] = [];
  let updated: Task = task;

  if (result.statusNote) {
    const status: Message = {
      id: nextId("m"),
      kind: "status",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: result.statusNote,
    };
    emitted.push(status);
  }

  // An assumption already recorded on this task is not recorded again, however
  // often an agent repeats it from step to step.
  const wording = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const recorded = new Set(
    office.messages.flatMap((m) => (m.kind === "assumption" && m.taskId === task.id ? [wording(m.assumed)] : [])),
  );

  for (const draft of result.assumptions) {
    if (recorded.has(wording(draft.assumed))) continue;
    recorded.add(wording(draft.assumed));
    const assumption: Message = {
      id: nextId("m"),
      kind: "assumption",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: draft.body ?? `Assuming: ${draft.assumed}`,
      assumed: draft.assumed,
      because: draft.because,
      confidence: draft.confidence,
      status: "open",
      affectsTaskIds: [task.id],
    };
    emitted.push(assumption);
    updated = { ...updated, assumptionIds: [...updated.assumptionIds, assumption.id] };
    notes.push(`${participant.displayName} recorded an assumption: ${draft.assumed}`);
  }

  for (const draft of result.questions) {
    const question: Message = {
      id: nextId("m"),
      kind: "question",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "participant", id: draft.toParticipantId },
      roomId: task.roomId,
      at: now,
      body: draft.body,
      blocking: draft.blocking,
      ...(draft.options ? { options: draft.options } : {}),
    };
    emitted.push(question);
    if (draft.blocking) {
      updated = {
        ...updated,
        openQuestionIds: [...updated.openQuestionIds, question.id],
        status: "blocked_question",
      };
      notes.push(`${participant.displayName} is waiting on an answer: ${draft.body}`);
    }
  }

  // Does this step need to reach into a room the agent may not touch?
  // Checked after the status and assumptions, because that is the order it
  // happens in: the agent works, records what it guessed, then hits the wall.
  let wallHit = false;

  for (const need of result.needs ?? []) {
    const verdict = resolveAccess(participant, need.room, need.scope, ctx);
    if (verdict.effect === "allow") continue;

    const supervisor =
      office.participants.find((p) => p.kind === "human" && roleMay(office.roles[p.roleId], "manage_access")) ??
      office.participants.find((p) => p.kind === "human");
    // Someone to hand the work to must hold the access and be able to carry
    // the task into its next room, which is what a reassignment requires.
    const onward = nextStage(task.stage);
    const carryRoom = onward ? (roomForStage(office, onward) ?? task.roomId) : task.roomId;
    const alternatives = office.participants.filter(
      (p) =>
        p.id !== participant.id &&
        p.kind === "agent" &&
        resolveAccess(p, need.room, need.scope, ctx).effect === "allow" &&
        canOwnWorkIn(p, carryRoom, ctx).effect === "allow",
    );
    const neededRoom = roomName(office, need.room);
    const purpose = need.purpose.trim().replace(/[.\s]+$/, "");

    const escalation: Message = {
      id: nextId("m"),
      kind: "escalation",
      taskId: task.id,
      fromId: participant.id,
      audience: supervisor ? { to: "participant", id: supervisor.id } : { to: "everyone" },
      roomId: task.roomId,
      at: now,
      body:
        `I need ${need.scope} access to ${neededRoom}. Purpose: ${purpose}. ` +
        `${verdict.explanation}. ` +
        (alternatives.length > 0
          ? `Grant me scoped access, or hand this to ${alternatives.map((p) => p.displayName).join(" / ")}.`
          : `Grant me scoped access. No other agent who could take this over holds it.`),
      cause: "permission",
      deniedDecision: verdict,
    };
    emitted.push(escalation);
    updated = {
      ...updated,
      status: "blocked_permission",
      history: [
        ...updated.history,
        {
          at: now,
          summary: `Blocked: needs ${need.scope} on ${neededRoom}`,
          messageId: escalation.id,
          decision: verdict,
        },
      ],
    };
    notes.push(
      `${participant.displayName} blocked on ${need.scope} access to ${neededRoom}. ${verdict.explanation}`,
    );
    wallHit = true;
    break;
  }

  // A playbook's output is written for a step that went through, so it only
  // lands when the step did. An AI agent's output was written knowing what it
  // could not see, so it is kept and marked as a draft.
  const asDraft = wallHit && participant.agentType === "ai";
  if (result.output && (!wallHit || asDraft)) {
    const output: Message = {
      id: nextId("m"),
      kind: "output",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: result.output.body,
      label: asDraft ? `Draft: ${result.output.label}` : result.output.label,
      // Only an AI agent's output comes from a model. A playbook's is canned.
      simulated: participant.agentType !== "ai",
    };
    emitted.push(output);
  }

  if (emitted.length > 0) {
    updated = {
      ...updated,
      history: [
        ...updated.history,
        { at: now, summary: `${participant.displayName} worked ${stageSpec(stage).label}` },
      ],
    };
  }

  return {
    office: { ...replaceTask(office, updated), messages: [...office.messages, ...emitted] },
    emitted,
    notes,
  };
}
